export type NullLike = null | undefined;

export type DeviceType = 'ios' | 'watchos';

export interface DeviceRecord {
  token: string;
  type: DeviceType;
  updated_at?: string;
}

export interface DBAdapter {
  countAll(): Promise<number>;
  deviceTokenByKey(key: string): Promise<DeviceRecord | NullLike>;
  saveDeviceTokenByKey(key: string, record: DeviceRecord): Promise<void>;
  deleteDeviceByKey(key: string): Promise<void>;
  saveAuthorizationToken(token: string, ttl: number): Promise<void>;
  getAuthorizationToken(): Promise<string | NullLike>;
}

export interface APNsResponse {
  status: number;
  message: string;
}

export interface Options {
  db: DBAdapter;
  allowNewDevice: boolean;
  allowQueryNums: boolean;
  maxBatchPushCount: number;
  basicAuth?: string;
  urlPrefix?: string;
  apnsUrl?: string;
}
