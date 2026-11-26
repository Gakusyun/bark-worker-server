import { afterEach, describe, expect, test } from '@rstest/core';
import {
  basicAuthHeader,
  type CreateTestAppOptions,
  createTestApp,
  getRegisteredDevice,
  jsonBody,
  postJson,
  registerDevice,
  request,
  seedLegacyDevice,
  type TestApp,
} from './helpers';

// Track every app created in a test so the global fetch stub is always
// restored (LIFO) even when a test creates more than one app.
const createdApps: TestApp[] = [];

const makeApp = (options: CreateTestAppOptions = {}): TestApp => {
  const testApp = createTestApp(options);
  createdApps.push(testApp);
  return testApp;
};

afterEach(() => {
  while (createdApps.length > 0) {
    createdApps.pop()?.restore();
  }
});

describe('Basic Auth', () => {
  test('protects private routes and keeps public routes open', async () => {
    const { app, authHeader } = makeApp({ basicAuth: 'user:pass' });
    expect(authHeader).toBe(basicAuthHeader('user:pass'));

    const unauthorizedInfo = await request(app, '/info');
    expect(unauthorizedInfo.status).toBe(401);
    expect(unauthorizedInfo.headers.get('www-authenticate')).toBe('Basic');

    const authorizedInfo = await request(app, '/info', {
      headers: { authorization: authHeader as string },
    });
    expect(authorizedInfo.status).toBe(200);
    const info = await jsonBody(authorizedInfo);
    expect(typeof info.version).toBe('string');

    const ping = await request(app, '/ping');
    expect(ping.status).toBe(200);

    const healthz = await request(app, '/healthz');
    expect(healthz.status).toBe(200);

    const registerPost = await postJson(app, '/register', {
      device_token: 'publictoken',
    });
    expect(registerPost.status).toBe(200);
    const registered = await jsonBody(registerPost);
    expect(registered.data.device_key).toBeTruthy();

    const registerGet = await request(
      app,
      '/register?device_token=publictoken2',
    );
    expect(registerGet.status).toBe(200);

    const registerCheck = await getRegisteredDevice(
      app,
      registered.data.device_key,
    );
    expect(registerCheck.status).toBe(200);

    const pushWithoutAuth = await postJson(app, '/push', {
      device_key: registered.data.device_key,
      body: 'nope',
    });
    expect(pushWithoutAuth.status).toBe(401);

    const v1WithoutAuth = await request(app, '/k/body');
    expect(v1WithoutAuth.status).toBe(401);
  });

  test('honors urlPrefix in the auth whitelist', async () => {
    const { app, authHeader } = makeApp({
      basicAuth: 'user:pass',
      urlPrefix: '/bark',
    });

    const unauthorized = await request(app, '/bark/info');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe('Basic');

    const authorized = await request(app, '/bark/info', {
      headers: { authorization: authHeader as string },
    });
    expect(authorized.status).toBe(200);

    const ping = await request(app, '/bark/ping');
    expect(ping.status).toBe(200);
  });
});

describe('register', () => {
  test('registers an ios device by default', async () => {
    const { app } = makeApp();
    const res = await postJson(app, '/register', {
      device_token: 'abcdef012345',
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.code).toBe(200);
    expect(body.data.device_key).toBeTruthy();
    expect(body.data.device_token).toBe('abcdef012345');
    expect(body.data.device_type).toBe('ios');

    const check = await getRegisteredDevice(app, body.data.device_key);
    expect(check.status).toBe(200);
    // upstream's register check only reports success, without device details
    const checkBody = await jsonBody(check);
    expect(checkBody.code).toBe(200);
  });

  test('echoes the watchos device type', async () => {
    const { app } = makeApp();
    const res = await postJson(app, '/register', {
      device_token: 'watchtoken01',
      device_type: 'watchos',
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.device_type).toBe('watchos');
  });

  test('rejects invalid device types', async () => {
    const { app } = makeApp();
    const res = await postJson(app, '/register', {
      device_token: 'sometoken01',
      device_type: 'android',
    });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.code).toBe(400);
    expect(body.message).toContain('invalid device type');
  });

  test('accepts 160-char tokens and rejects 161-char tokens', async () => {
    const { app } = makeApp();

    const ok = await postJson(app, '/register', {
      device_token: 'a'.repeat(160),
    });
    expect(ok.status).toBe(200);
    const okBody = await jsonBody(ok);
    expect(okBody.data.device_token).toHaveLength(160);

    const tooLong = await postJson(app, '/register', {
      device_token: 'a'.repeat(161),
    });
    expect(tooLong.status).toBe(400);
    const tooLongBody = await jsonBody(tooLong);
    expect(tooLongBody.code).toBe(400);
    expect(tooLongBody.message).toContain('device token is invalid');
  });

  test('returns device status for existing keys and 400 for missing keys', async () => {
    const { app } = makeApp();
    const registered = await registerDevice(app);

    const existing = await getRegisteredDevice(app, registered.key);
    expect(existing.status).toBe(200);
    // upstream's register check only reports success, without device details
    const existingBody = await jsonBody(existing);
    expect(existingBody.code).toBe(200);

    const missing = await getRegisteredDevice(app, 'missingkey');
    expect(missing.status).toBe(400);
    const missingBody = await jsonBody(missing);
    expect(missingBody.code).toBe(400);
    expect(missingBody.message).toContain('device token');
  });

  test('serves legacy bare-token KV values as ios devices', async () => {
    const { app, kv, apnsCalls } = makeApp();
    seedLegacyDevice(kv, 'legacykey1', 'legacytokenabc123');

    const res = await postJson(app, '/push', {
      device_key: 'legacykey1',
      body: 'legacy',
    });
    expect(res.status).toBe(200);
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0].headers['apns-topic']).toBe('me.fin.bark');
    expect(apnsCalls[0].url).toContain('/3/device/legacytokenabc123');
  });
});

describe('push payload', () => {
  test('sends title, ttl and custom params to APNs', async () => {
    const { app, apnsCalls } = makeApp();
    const device = await registerDevice(app);

    const before = Math.floor(Date.now() / 1000);
    const res = await postJson(app, '/push', {
      device_key: device.key,
      body: 'hello',
      title: 'greeting',
      ttl: 60,
      foo: 'bar',
    });
    const after = Math.floor(Date.now() / 1000);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.code).toBe(200);

    expect(apnsCalls).toHaveLength(1);
    const call = apnsCalls[0];
    expect(call.url).toBe(`https://api.test/3/device/${device.token}`);
    expect(call.headers['apns-topic']).toBe('me.fin.bark');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body.aps.alert.title).toBe('greeting');
    expect(call.body.aps.alert.body).toBe('hello');
    expect(call.body.ttl).toBe('60');
    expect(call.body.foo).toBe('bar');

    // Upstream v2.4.0 fixes the APNs expiration at now + 24h; ttl is only
    // forwarded to the client as a payload extension (asserted above).
    const expiration = Number(call.headers['apns-expiration']);
    expect(Number.isInteger(expiration)).toBe(true);
    expect(Math.abs(expiration - (before + 86400))).toBeLessThanOrEqual(60);
    expect(expiration).toBeGreaterThanOrEqual(after + 86400 - 60);
  });

  test('merges ext_params into the payload', async () => {
    const { app, apnsCalls } = makeApp();
    const device = await registerDevice(app);

    const res = await postJson(app, '/push', {
      device_key: device.key,
      body: 'ext',
      ext_params: { custom: 'x' },
    });
    expect(res.status).toBe(200);
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0].body.custom).toBe('x');
    expect(apnsCalls[0].body.ext_params).toBeUndefined();
  });

  test('accepts push parameters from the query string', async () => {
    const { app, apnsCalls } = makeApp();
    const device = await registerDevice(app);

    const withBody = await request(
      app,
      `/push?device_key=${device.key}&body=q`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'query-title' }),
      },
    );
    expect(withBody.status).toBe(200);
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0].body.aps.alert.title).toBe('query-title');
    expect(apnsCalls[0].body.aps.alert.body).toBe('q');

    const noBody = await request(
      app,
      `/push?device_key=${device.key}&body=q2`,
      { method: 'POST' },
    );
    expect(noBody.status).toBe(200);
    expect(apnsCalls).toHaveLength(2);
    expect(apnsCalls[1].body.aps.alert.body).toBe('q2');
  });

  test('uses the watchos APNs topic for watchos devices', async () => {
    const { app, apnsCalls } = makeApp();
    const device = await registerDevice(app, { deviceType: 'watchos' });

    const res = await postJson(app, '/push', {
      device_key: device.key,
      body: 'watch',
    });
    expect(res.status).toBe(200);
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0].headers['apns-topic']).toBe('me.fin.bark.watch');
  });
});

describe('batch push', () => {
  test('returns per-device results for array and CSV device_keys', async () => {
    const { app, apnsCalls } = makeApp();
    const first = await registerDevice(app);
    const second = await registerDevice(app);

    const res = await postJson(app, '/push', {
      device_keys: [first.key, second.key],
      body: 'x',
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.code).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data.every((item: any) => item.code === 200)).toBe(true);
    // per-device results are flat, not nested under another data field
    expect(body.data.every((item: any) => item.data === undefined)).toBe(true);
    expect(body.data.map((item: any) => item.device_key).sort()).toEqual(
      [first.key, second.key].sort(),
    );
    expect(apnsCalls).toHaveLength(2);

    const csv = await postJson(app, '/push', {
      device_keys: `${first.key},${second.key}`,
      body: 'x',
    });
    expect(csv.status).toBe(200);
    const csvBody = await jsonBody(csv);
    expect(Array.isArray(csvBody.data)).toBe(true);
    expect(csvBody.data).toHaveLength(2);
    expect(csvBody.data.map((item: any) => item.device_key).sort()).toEqual(
      [first.key, second.key].sort(),
    );
    expect(apnsCalls).toHaveLength(4);
  });

  test('rejects batches above maxBatchPushCount', async () => {
    const { app, apnsCalls } = makeApp({ maxBatchPushCount: 2 });

    const res = await postJson(app, '/push', {
      device_keys: ['keyone', 'keytwo', 'keythree'],
      body: 'x',
    });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.code).toBe(400);
    expect(body.message).toContain(
      'batch push count exceeds the maximum limit: 2',
    );
    expect(apnsCalls).toHaveLength(0);
  });
});

describe('V1 routes', () => {
  test('GET /:device_key/:title/:body maps path and query parameters', async () => {
    const { app, apnsCalls } = makeApp();
    const device = await registerDevice(app);

    const res = await request(app, `/${device.key}/Hello/World?sound=alarm`);
    expect(res.status).toBe(200);
    expect(apnsCalls).toHaveLength(1);
    const call = apnsCalls[0];
    expect(call.body.aps.alert.title).toBe('Hello');
    expect(call.body.aps.alert.body).toBe('World');
    expect(call.body.aps.sound).toBe('alarm.caf');
  });

  test('POST /:device_key merges query and JSON body parameters', async () => {
    const { app, apnsCalls } = makeApp();
    const device = await registerDevice(app);

    const res = await request(app, `/${device.key}?title=qTitle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'b' }),
    });
    expect(res.status).toBe(200);
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0].body.aps.alert.title).toBe('qTitle');
    expect(apnsCalls[0].body.aps.alert.body).toBe('b');
  });

  test('rejects malformed percent-encoding in path parameters', async () => {
    const { app, apnsCalls } = makeApp();

    const res = await request(app, '/k/%E0%A4%A');
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.code).toBe(400);
    expect(body.message).toBe('url path parse failed');
    expect(apnsCalls).toHaveLength(0);
  });
});

describe('APNs failures', () => {
  test('410 invalidates the device token and surfaces the status', async () => {
    const { app } = makeApp({
      responder: () => ({ status: 410, reason: 'Unregistered' }),
    });
    const device = await registerDevice(app);

    const res = await postJson(app, '/push', {
      device_key: device.key,
      body: 'gone',
    });
    expect(res.status).toBe(410);
    const body = await jsonBody(res);
    expect(body.code).toBe(410);
    expect(body.message).toContain('push failed');
    expect(body.message).toContain('Unregistered');

    const check = await getRegisteredDevice(app, device.key);
    expect(check.status).toBe(400);
  });

  test('400 BadDeviceToken invalidates the device token', async () => {
    const { app } = makeApp({
      responder: () => ({ status: 400, reason: 'BadDeviceToken' }),
    });
    const device = await registerDevice(app);

    const res = await postJson(app, '/push', {
      device_key: device.key,
      body: 'bad',
    });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.code).toBe(400);
    expect(body.message).toContain('BadDeviceToken');

    const check = await getRegisteredDevice(app, device.key);
    expect(check.status).toBe(400);
  });

  test('retries once after ExpiredProviderToken', async () => {
    const { app, fetchStub, apnsCalls } = makeApp();
    fetchStub.setResponder((_call, index) =>
      index === 0
        ? { status: 403, reason: 'ExpiredProviderToken' }
        : { status: 200, reason: 'ok' },
    );
    const device = await registerDevice(app);

    const res = await postJson(app, '/push', {
      device_key: device.key,
      body: 'retry',
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.code).toBe(200);
    expect(apnsCalls).toHaveLength(2);
    expect(apnsCalls[0].url).toBe(apnsCalls[1].url);
    expect(apnsCalls[1].headers['apns-topic']).toBe('me.fin.bark');
  });
});

describe('/info', () => {
  test('returns build metadata and the device count', async () => {
    const { app } = makeApp({ allowQueryNums: true });
    await registerDevice(app);

    const res = await request(app, '/info');
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(typeof body.version).toBe('string');
    expect(typeof body.build).toBe('string');
    expect(typeof body.commit).toBe('string');
    expect(body.arch).toBe('js/esa');
    expect(typeof body.devices).toBe('number');
    expect(body.devices).toBeGreaterThanOrEqual(1);
    expect(typeof body.time).toBe('number');
  });
});
