import { type BasicKV, KVAdapter } from '../src/db';
import { createHono } from '../src/hono';
import type { DeviceRecord, DeviceType } from '../src/type';

/**
 * In-memory implementation of the EdgeKV subset used by the server.
 *
 * Behavior mirrors the Aliyun EdgeKV API that src/db.ts depends on:
 * - `type: 'text'` returns the raw stored string
 * - `type: 'json'` parses the stored string
 * - otherwise it tries JSON.parse and falls back to the raw string
 * - missing keys return undefined
 */
export class MemoryKV implements BasicKV {
  readonly store = new Map<string, string>();

  async get(key: string, options?: { type: 'json' | 'text' }): Promise<any> {
    const raw = this.store.get(key);
    if (raw === undefined) {
      return undefined;
    }
    if (options?.type === 'text') {
      return raw;
    }
    if (options?.type === 'json') {
      return JSON.parse(raw);
    }
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Write a value directly, bypassing KVAdapter. */
  seed(key: string, value: string): this {
    this.store.set(key, value);
    return this;
  }

  /** Read a raw value directly. */
  peek(key: string): string | undefined {
    return this.store.get(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): string[] {
    return [...this.store.keys()];
  }

  clear(): void {
    this.store.clear();
  }
}

// Mirrors sanitizeDeviceKey in src/db.ts so tests can seed the same keys the
// adapter reads.
const sanitizeDeviceKey = (key: string) =>
  (key || '').replace(/[^a-zA-Z0-9]/g, '') || '_PLACE_HOLDER_';

export const deviceKvKey = (key: string) => `device_${sanitizeDeviceKey(key)}`;

/** Seed a device record (the JSON format written by KVAdapter). */
export const seedDeviceRecord = (
  kv: MemoryKV,
  key: string,
  record: DeviceRecord,
) => {
  kv.seed(deviceKvKey(key), JSON.stringify(record));
};

/** Seed the legacy format where the KV value is the raw device token. */
export const seedLegacyDevice = (kv: MemoryKV, key: string, token: string) => {
  kv.seed(deviceKvKey(key), token);
};

export interface ApnsCall {
  url: string;
  headers: Record<string, string>;
  body: any;
  rawBody: string;
}

export interface ApnsResponseSpec {
  status?: number;
  reason?: string;
  /** Raw response body; overrides the `reason` JSON envelope when provided. */
  body?: string;
}

export type ApnsResponder = (
  call: ApnsCall,
  index: number,
) => ApnsResponseSpec | Response | Promise<ApnsResponseSpec | Response>;

export const APNS_OK: ApnsResponseSpec = { status: 200, reason: 'ok' };

const normalizeHeaders = (
  headers: HeadersInit | undefined,
): Record<string, string> => {
  const result: Record<string, string> = {};
  if (!headers) {
    return result;
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }
    return result;
  }
  for (const [key, value] of Object.entries(
    headers as Record<string, string>,
  )) {
    if (value !== undefined && value !== null) {
      result[key] = String(value);
    }
  }
  return result;
};

const buildApnsResponse = (spec: ApnsResponseSpec = APNS_OK): Response => {
  const status = spec.status ?? 200;
  const body = spec.body ?? JSON.stringify({ reason: spec.reason ?? 'ok' });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
};

export interface FetchStub {
  readonly calls: ApnsCall[];
  readonly installed: boolean;
  setResponder(responder: ApnsResponder): void;
  install(): void;
  restore(): void;
}

/**
 * Stub globalThis.fetch so APNs requests are captured instead of sent.
 * Save the original fetch on install and restore it in afterEach.
 */
export const createApnsFetchStub = (responder?: ApnsResponder): FetchStub => {
  const calls: ApnsCall[] = [];
  let currentResponder: ApnsResponder = responder ?? (() => APNS_OK);
  let originalFetch: typeof globalThis.fetch | undefined;
  let isInstalled = false;

  const stub: FetchStub = {
    calls,
    get installed() {
      return isInstalled;
    },
    setResponder(next) {
      currentResponder = next;
    },
    install() {
      if (isInstalled) {
        return;
      }
      originalFetch = globalThis.fetch;
      isInstalled = true;
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const rawBody = typeof init?.body === 'string' ? init.body : '';
        let body: any = rawBody;
        if (rawBody) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            body = rawBody;
          }
        }
        const call: ApnsCall = {
          url,
          headers: normalizeHeaders(init?.headers),
          body,
          rawBody,
        };
        calls.push(call);
        const result = await currentResponder(call, calls.length - 1);
        return result instanceof Response ? result : buildApnsResponse(result);
      }) as typeof globalThis.fetch;
    },
    restore() {
      if (!isInstalled) {
        return;
      }
      globalThis.fetch = originalFetch as typeof globalThis.fetch;
      originalFetch = undefined;
      isInstalled = false;
    },
  };

  return stub;
};

export interface CreateTestAppOptions {
  basicAuth?: string;
  urlPrefix?: string;
  apnsUrl?: string;
  allowNewDevice?: boolean;
  allowQueryNums?: boolean;
  maxBatchPushCount?: number;
  kv?: MemoryKV;
  responder?: ApnsResponder;
  /** Set to false to skip installing the fetch stub (default: installed). */
  installFetch?: boolean;
}

export type TestHono = ReturnType<typeof createHono>;

export interface TestApp {
  app: TestHono;
  kv: MemoryKV;
  db: KVAdapter;
  fetchStub: FetchStub;
  apnsCalls: ApnsCall[];
  authHeader?: string;
  restore(): void;
}

export const basicAuthHeader = (credentials: string) =>
  `Basic ${btoa(credentials)}`;

export const createTestApp = (options: CreateTestAppOptions = {}): TestApp => {
  const kv = options.kv ?? new MemoryKV();
  const fetchStub = createApnsFetchStub(options.responder);
  if (options.installFetch !== false) {
    fetchStub.install();
  }
  const db = new KVAdapter(kv);
  const app = createHono({
    db,
    allowNewDevice: options.allowNewDevice ?? true,
    allowQueryNums: options.allowQueryNums ?? true,
    maxBatchPushCount: options.maxBatchPushCount ?? 1000,
    basicAuth: options.basicAuth,
    urlPrefix: options.urlPrefix,
    apnsUrl: options.apnsUrl ?? 'api.test',
  });

  return {
    app,
    kv,
    db,
    fetchStub,
    apnsCalls: fetchStub.calls,
    authHeader: options.basicAuth
      ? basicAuthHeader(options.basicAuth)
      : undefined,
    restore: () => fetchStub.restore(),
  };
};

export const request = async (
  app: TestHono,
  path: string,
  init?: RequestInit,
): Promise<Response> => app.request(path, init);

export const jsonBody = async <T = any>(res: Response): Promise<T> =>
  (await res.json()) as T;

export const postJson = async (
  app: TestHono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  request(app, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

export const randomDeviceToken = () =>
  globalThis.crypto.randomUUID().replace(/-/g, '');

export interface RegisteredDevice {
  key: string;
  token: string;
  type: DeviceType;
  response: any;
}

/**
 * Register a device through the public API (preferred over seeding KV) and
 * return the key/token/type from the response.
 */
export const registerDevice = async (
  app: TestHono,
  options: { deviceToken?: string; deviceType?: string; auth?: string } = {},
): Promise<RegisteredDevice> => {
  const token = options.deviceToken ?? randomDeviceToken();
  const payload: Record<string, string> = { device_token: token };
  if (options.deviceType !== undefined) {
    payload.device_type = options.deviceType;
  }
  const res = await postJson(
    app,
    '/register',
    payload,
    options.auth ? { authorization: options.auth } : {},
  );
  const response = await jsonBody(res);
  if (res.status !== 200) {
    throw new Error(
      `device registration failed (${res.status}): ${JSON.stringify(response)}`,
    );
  }
  return {
    key: response.data.device_key,
    token,
    type: response.data.device_type as DeviceType,
    response,
  };
};

export const getRegisteredDevice = (
  app: TestHono,
  deviceKey: string,
): Promise<Response> =>
  request(app, `/register/${encodeURIComponent(deviceKey)}`);
