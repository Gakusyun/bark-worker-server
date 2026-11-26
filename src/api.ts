import { IOS_TOPIC, push, regenerateAuthToken, WATCHOS_TOPIC } from './apns';
import type { DBAdapter, DeviceRecord, DeviceType, Options } from './type';
import { getTimestamp, newShortUUID } from './utils';

// Injected by rsbuild at build time. The fallback keeps direct source imports
// (e.g. tests) working.
const BUILD_VERSION =
  typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev';
const BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : '';
const BUILD_COMMIT =
  typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : '';

export class APIError extends Error {
  code: number;
  message: string;
  timestamp: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.message = message;
    this.timestamp = getTimestamp();
  }
}

const buildSuccess = (data?: any, message = 'success') => ({
  code: 200,
  message,
  timestamp: getTimestamp(),
  data,
});

export type PushParameters = Partial<{
  device_key: string;
  device_keys: string[] | string;

  title: string;
  subtitle: string;
  body: string;
  sound: string;
  group: string;
  call: boolean;
  isArchive: boolean;
  icon: string;
  ciphertext: string;
  level: string;
  volume: number;
  url: string;
  image: string;
  copy: boolean;
  badge: number;
  autoCopy: boolean;
  action: string;
  iv: string;
  id: string;
  delete: boolean;
  markdown: string;
  ttl: number | string;
  ext_params: Record<string, any>;
}> &
  Record<string, any>;

// delete accepts 1/1.0/"1" (upstream) and boolean true (worker convenience)
const isDelete = (value: unknown) =>
  value === true ||
  value === 1 ||
  value === '1' ||
  value === 1.0 ||
  value === '1.0' ||
  value === 'true';

export class API {
  db: DBAdapter;
  options: Options;

  constructor(options: Options) {
    this.db = options.db;
    this.options = options;
  }

  async register(deviceToken?: string, key?: string, deviceType?: string) {
    if (!deviceToken) {
      throw new APIError(400, 'device token is empty');
    }

    if (deviceToken.length > 160) {
      throw new APIError(400, 'device token is invalid');
    }

    if (deviceType && deviceType !== 'ios' && deviceType !== 'watchos') {
      throw new APIError(400, 'device type is invalid');
    }
    const type: DeviceType = deviceType === 'watchos' ? 'watchos' : 'ios';

    if (!(key && (await this.db.deviceTokenByKey(key)))) {
      if (this.options.allowNewDevice) {
        key = await newShortUUID();
      } else {
        throw new APIError(
          500,
          'device registration failed: register disabled',
        );
      }
    }

    if (deviceToken === 'deleted') {
      await this.db.deleteDeviceByKey(key);
      return buildSuccess({
        key: key,
        device_key: key,
        device_token: 'deleted',
        device_type: type,
      });
    }

    const record: DeviceRecord = {
      token: deviceToken,
      type,
      updated_at: new Date().toISOString(),
    };
    await this.db.saveDeviceTokenByKey(key, record);
    return buildSuccess({
      key: key,
      device_key: key,
      device_token: deviceToken,
      device_type: type,
    });
  }

  async checkRegister(deviceKey: string) {
    const record = await this.db.deviceTokenByKey(deviceKey);
    if (record === undefined || record === null || !record.token) {
      throw new APIError(400, 'device token not found');
    }
    return buildSuccess({
      device_key: deviceKey,
      device_type: record.type,
    });
  }

  ping() {
    return buildSuccess(undefined, 'pong');
  }

  async info() {
    let devices: number | undefined;
    if (this.options.allowQueryNums) {
      devices = await this.db.countAll();
    }

    return {
      version: BUILD_VERSION ? `v${BUILD_VERSION.replace(/^v/, '')}` : 'dev',
      build: BUILD_DATE,
      arch: 'js/esa',
      commit: BUILD_COMMIT,
      time: Date.now(),
      devices: devices,
    };
  }

  private normalizeParameters(parameters: PushParameters) {
    const normalized: Record<string, any> = {};
    for (const [key, value] of Object.entries(parameters || {})) {
      if (value !== undefined && value !== null) {
        normalized[key.toLowerCase()] = value;
      }
    }

    const extParams = normalized.ext_params;
    if (
      extParams &&
      typeof extParams === 'object' &&
      !Array.isArray(extParams)
    ) {
      for (const [key, value] of Object.entries(extParams)) {
        if (value !== undefined && value !== null) {
          normalized[key.toLowerCase()] = value;
        }
      }
    }
    return normalized;
  }

  async push(rawParameters: PushParameters) {
    const parameters = this.normalizeParameters(rawParameters);

    // upstream accepts both an array and a comma-separated string
    if (typeof parameters.device_keys === 'string') {
      parameters.device_keys = parameters.device_keys
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);
    }

    // batch
    if (
      Array.isArray(parameters.device_keys) &&
      parameters.device_keys.length > 0
    ) {
      if (
        !Number.isNaN(this.options.maxBatchPushCount) &&
        this.options.maxBatchPushCount > 0
      ) {
        if (parameters.device_keys.length > this.options.maxBatchPushCount) {
          throw new APIError(
            400,
            `batch push count exceeds the maximum limit: ${this.options.maxBatchPushCount}`,
          );
        }
      }

      return buildSuccess(
        await Promise.all(
          parameters.device_keys.map(async (deviceKey) => {
            try {
              const res = await this.pushOne(deviceKey, parameters);
              return {
                code: res.code,
                device_key: deviceKey,
              };
            } catch (e) {
              if (e instanceof Error) {
                return {
                  code: e instanceof APIError ? e.code : 500,
                  device_key: deviceKey,
                  message: e.message,
                };
              }
            }
          }),
        ),
      );
    }

    const deviceKey = parameters.device_key;
    if (!deviceKey) {
      throw new APIError(400, 'device key is empty');
    }
    return this.pushOne(deviceKey, parameters);
  }

  private async pushOne(deviceKey: string, parameters: Record<string, any>) {
    const record = await this.db.deviceTokenByKey(deviceKey);
    if (record === undefined || record === null) {
      throw new APIError(
        400,
        `failed to get device token: failed to get [${deviceKey}] device token from database`,
      );
    }

    if (!record.token) {
      throw new APIError(400, 'device token invalid');
    }
    const deviceToken = record.token;
    const title = parameters.title || undefined;
    const subtitle = parameters.subtitle || undefined;
    const body = parameters.body || undefined;
    const deletePush = isDelete(parameters.delete);

    let sound = parameters.sound ? String(parameters.sound) : undefined;
    if (sound) {
      if (!sound.endsWith('.caf')) {
        sound += '.caf';
      }
    } else {
      sound = '1107';
    }

    // https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification
    const aps: Record<string, any> = {
      aps: deletePush
        ? {
            'content-available': 1,
            'mutable-content': 1,
          }
        : {
            alert: {
              title: title,
              subtitle: subtitle,
              body: !title && !subtitle && !body ? 'Empty Message' : body,
            },
            sound: sound,
            'thread-id': parameters.group,
            category: 'myNotificationCategory',
            'mutable-content': 1,
          },
    };

    // Everything that is not part of the APNs envelope is forwarded as an
    // extension parameter, so ttl and custom parameters reach the client.
    const reserved = new Set([
      'device_key',
      'device_keys',
      'ext_params',
      'title',
      'subtitle',
      'body',
      'sound',
    ]);
    for (const [key, value] of Object.entries(parameters)) {
      if (reserved.has(key) || value === undefined || value === null) {
        continue;
      }
      aps[key] = String(value);
    }

    const headers: Record<string, string> = {
      'apns-push-type': deletePush ? 'background' : 'alert',
      'apns-topic': record.type === 'watchos' ? WATCHOS_TOPIC : IOS_TOPIC,
    };
    if (parameters.id) {
      headers['apns-collapse-id'] = String(parameters.id);
    }
    const ttl = Number(parameters.ttl);
    if (Number.isFinite(ttl) && ttl > 0) {
      headers['apns-expiration'] = String(getTimestamp() + ttl);
    }

    const handleResponse = async (
      resp: Awaited<ReturnType<typeof push>>,
      retryCount = 0,
    ) => {
      if (resp.status === 200) {
        return buildSuccess(undefined);
      }
      if (
        resp.status === 410 ||
        (resp.status === 400 && resp.message.includes('BadDeviceToken'))
      ) {
        await this.db.deleteDeviceByKey(deviceKey);
      }

      if (
        retryCount === 0 &&
        resp.status === 403 &&
        resp.message.includes('ExpiredProviderToken')
      ) {
        // Token expired, try again
        await regenerateAuthToken(this.db);
        return handleResponse(
          await push(this.options, deviceToken, headers, aps),
          retryCount + 1,
        );
      }

      throw new APIError(resp.status, `push failed: ${resp.message}`);
    };

    const response = await push(this.options, deviceToken, headers, aps);

    return await handleResponse(response);
  }
}
