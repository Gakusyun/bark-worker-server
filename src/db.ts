import type { DBAdapter, DeviceRecord } from './type';

export interface BasicKV {
  get(key: string, options?: { type: 'json' | 'text' }): Promise<any>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// keep read and write paths consistent, and avoid characters that are
// awkward in KV keys
const sanitizeDeviceKey = (key: string) =>
  (key || '').replace(/[^a-zA-Z0-9]/g, '') || '_PLACE_HOLDER_';

const decodeDeviceRecord = (raw: string): DeviceRecord => {
  // legacy value: the KV value was a bare device token
  if (!raw.startsWith('{')) {
    return { token: raw, type: 'ios' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') {
      return { token: parsed, type: 'ios' };
    }
    if (parsed && typeof parsed.token === 'string') {
      return {
        token: parsed.token,
        type: parsed.type === 'watchos' ? 'watchos' : 'ios',
        updated_at:
          typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined,
      };
    }
  } catch {
    // fall through to the bare token fallback
  }
  return { token: raw, type: 'ios' };
};

export class KVAdapter implements DBAdapter {
  kv: BasicKV;
  constructor(kv: BasicKV) {
    if (!kv) {
      throw new Error('kv database not found');
    }
    this.kv = kv;
  }

  async countAll() {
    const c = Number(await this.kv.get('deviceCount'));
    return Number.isNaN(c) ? 0 : c;
  }
  async updateCount(diff: number) {
    const count = await this.countAll();
    await this.kv.put('deviceCount', String(count + diff));
  }

  async deviceTokenByKey(key: string) {
    const raw = await this.kv.get(`device_${sanitizeDeviceKey(key)}`, {
      type: 'text',
    });
    if (raw === undefined || raw === null) {
      return raw;
    }
    if (raw === '') {
      return { token: '', type: 'ios' };
    }
    return decodeDeviceRecord(raw);
  }

  async saveDeviceTokenByKey(key: string, record: DeviceRecord) {
    if (!record.token) {
      return this.deleteDeviceByKey(key);
    }
    const deviceToken = (record.token || '').replace(/[^a-z0-9]/g, '') || '';
    const k = `device_${sanitizeDeviceKey(key)}`;
    const existing = await this.kv.get(k, { type: 'text' });
    if (!existing) {
      await this.updateCount(1);
    }
    return this.kv.put(
      k,
      JSON.stringify({
        token: deviceToken,
        type: record.type,
        updated_at: record.updated_at,
      }),
    );
  }

  async deleteDeviceByKey(key: string) {
    const k = `device_${sanitizeDeviceKey(key)}`;
    const existing = await this.kv.get(k, { type: 'text' });
    if (existing) {
      await this.updateCount(-1);
    }
    return this.kv.delete(k);
  }

  async saveAuthorizationToken(token: string, ttl: number) {
    const expireAt = Date.now() + ttl;
    await this.kv.put('authToken', JSON.stringify({ token, expireAt }));
  }

  async getAuthorizationToken() {
    const res = await this.kv.get('authToken');
    if (!res || res.expireAt <= Date.now()) {
      return undefined;
    }
    return res.token;
  }
}
