import { IOS_TOPIC, push, regenerateAuthToken, WATCHOS_TOPIC } from './apns';
import type { DBAdapter, DeviceRecord, DeviceType, Options } from './type';
import { getTimestamp, newShortUUID } from './utils';

// Injected by rsbuild at build time. The fallback keeps direct source imports
// (e.g. tests) working.
const BUILD_VERSION =
  typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : '';
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
    if (!deviceToken || typeof deviceToken !== 'string') {
      throw new APIError(400, 'device token is empty');
    }

    if (deviceToken.length > 160) {
      throw new APIError(400, 'device token is invalid');
    }

    const normalizedDeviceType = (deviceType || '').toLowerCase();
    if (
      normalizedDeviceType &&
      normalizedDeviceType !== 'ios' &&
      normalizedDeviceType !== 'watchos'
    ) {
      throw new APIError(400, `invalid device type: ${deviceType}`);
    }
    const type: DeviceType =
      normalizedDeviceType === 'watchos' ? 'watchos' : 'ios';

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
      updated_at: getTimestamp(),
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
    if (record === undefined || record === null) {
      throw new APIError(
        400,
        `failed to get [${deviceKey}] device token from database`,
      );
    }
    if (!record.token) {
      throw new APIError(400, 'device token invalid');
    }
    return buildSuccess();
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
      if (value === undefined || value === null) {
        continue;
      }
      if (typeof value === 'object' && !Array.isArray(value)) {
        // upstream flattens every object-valued parameter into ExtParams
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          if (nestedValue !== undefined) {
            normalized[nestedKey.toLowerCase()] = nestedValue;
          }
        }
      } else {
        normalized[key.toLowerCase()] = value;
      }
    }
    return normalized;
  }

  async push(rawParameters: PushParameters, options: { batch?: boolean } = {}) {
    const input: Record<string, any> = {};
    for (const [key, value] of Object.entries(rawParameters || {})) {
      input[key.toLowerCase()] = value;
    }

    // Batch push is only recognized for JSON (V2) requests, matching
    // upstream. Both an array and a comma-separated string are accepted.
    let deviceKeys: string[] = [];
    if (options.batch !== false && 'device_keys' in input) {
      const rawKeys = input.device_keys;
      if (typeof rawKeys === 'string') {
        deviceKeys = rawKeys.split(',');
      } else if (Array.isArray(rawKeys)) {
        deviceKeys = rawKeys.map((key) => String(key));
      } else {
        throw new APIError(400, 'invalid type for device_keys');
      }
      delete input.device_keys;
    }

    const parameters = this.normalizeParameters(input);

    if (deviceKeys.length > 0) {
      const max = this.options.maxBatchPushCount;
      if (Number.isFinite(max) && max !== -1 && deviceKeys.length > max) {
        throw new APIError(
          400,
          `batch push count exceeds the maximum limit: ${max}`,
        );
      }

      return buildSuccess(
        await Promise.all(
          deviceKeys.map(async (deviceKey) => {
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

    const deviceKey =
      typeof parameters.device_key === 'string' ? parameters.device_key : '';
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
    const title =
      typeof parameters.title === 'string' && parameters.title
        ? parameters.title
        : undefined;
    const subtitle =
      typeof parameters.subtitle === 'string' && parameters.subtitle
        ? parameters.subtitle
        : undefined;
    const body =
      typeof parameters.body === 'string' && parameters.body
        ? parameters.body
        : undefined;
    const deletePush = isDelete(parameters.delete);

    let sound = '1107';
    if (typeof parameters.sound === 'string') {
      sound = parameters.sound.endsWith('.caf')
        ? parameters.sound
        : `${parameters.sound}.caf`;
    }
    const group =
      typeof parameters.group === 'string' ? parameters.group : undefined;

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
            'thread-id': group,
            category: 'myNotificationCategory',
            'mutable-content': 1,
          },
    };

    // Everything that is not part of the APNs envelope is forwarded as an
    // extension parameter, so ttl and custom parameters reach the client.
    const specialStringKeys = new Set(['title', 'subtitle', 'body', 'sound']);
    for (const [key, value] of Object.entries(parameters)) {
      if (key === 'device_key' || key === 'ext_params') {
        continue;
      }
      if (specialStringKeys.has(key) && typeof value === 'string') {
        continue;
      }
      aps[key] = String(value);
    }

    const headers: Record<string, string> = {
      'apns-push-type': deletePush ? 'background' : 'alert',
      'apns-topic': record.type === 'watchos' ? WATCHOS_TOPIC : IOS_TOPIC,
    };
    if (typeof parameters.id === 'string' && parameters.id) {
      headers['apns-collapse-id'] = parameters.id;
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
        // Keep the device key around like upstream does, but clear the
        // invalid token so it can be replaced by a new registration.
        await this.db.saveDeviceTokenByKey(deviceKey, {
          token: '',
          type: record.type,
          updated_at: getTimestamp(),
        });
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
