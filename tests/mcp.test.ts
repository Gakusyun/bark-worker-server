import { afterEach, describe, expect, test } from '@rstest/core';
import {
  basicAuthHeader,
  type CreateTestAppOptions,
  createTestApp,
  jsonBody,
  postJson,
  registerDevice,
  request,
  type TestApp,
  type TestHono,
} from './helpers';

interface JsonRpcError {
  code: number;
  message: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: any;
  error?: JsonRpcError;
}

interface InitializeOutcome {
  response: Response;
  sessionId: string | null;
  body?: JsonRpcResponse;
}

const MCP_SESSION_ID_PATTERN = /^mcp-session-[0-9a-f-]{36}$/i;

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

const initializeBody = (protocolVersion?: string) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: protocolVersion === undefined ? {} : { protocolVersion },
});

/** Perform the initialize handshake on an MCP endpoint. */
const initialize = async (
  app: TestHono,
  path = '/mcp',
  protocolVersion?: string,
): Promise<InitializeOutcome> => {
  const response = await postJson(app, path, initializeBody(protocolVersion));
  const sessionId = response.headers.get('mcp-session-id');
  const body =
    response.status === 200
      ? await jsonBody<JsonRpcResponse>(response)
      : undefined;
  return { response, sessionId, body };
};

/** Perform the initialize handshake and return the issued session id. */
const initializeSession = async (
  app: TestHono,
  path = '/mcp',
  protocolVersion?: string,
): Promise<string> => {
  const { response, sessionId } = await initialize(app, path, protocolVersion);
  if (response.status !== 200 || !sessionId) {
    throw new Error(`initialize failed with status ${response.status}`);
  }
  return sessionId;
};

/** Send a JSON-RPC request carrying the Mcp-Session-Id header. */
const sendRpc = (
  app: TestHono,
  body: unknown,
  sessionId: string,
  path = '/mcp',
  headers: Record<string, string> = {},
): Promise<Response> =>
  postJson(app, path, body, { 'mcp-session-id': sessionId, ...headers });

const sendRpcJson = async (
  app: TestHono,
  body: unknown,
  sessionId: string,
  path = '/mcp',
): Promise<{ response: Response; body: JsonRpcResponse }> => {
  const response = await sendRpc(app, body, sessionId, path);
  return { response, body: await jsonBody<JsonRpcResponse>(response) };
};

const protocolLabel = (requested?: string) => {
  if (requested === undefined) {
    return 'missing';
  }
  if (requested === '') {
    return 'empty';
  }
  return requested;
};

describe('MCP content type', () => {
  for (const path of ['/mcp', '/mcp/devicekey']) {
    test(`rejects non-JSON content types on ${path}`, async () => {
      const { app, apnsCalls } = makeApp();

      const missing = await request(app, path, { method: 'POST' });
      expect(missing.status).toBe(400);
      expect((await missing.text()).startsWith('Invalid content type')).toBe(
        true,
      );

      const wrong = await request(app, path, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify(initializeBody()),
      });
      expect(wrong.status).toBe(400);
      expect((await wrong.text()).startsWith('Invalid content type')).toBe(
        true,
      );
      expect(apnsCalls).toHaveLength(0);
    });
  }

  test('accepts application/json with parameters on both endpoints', async () => {
    const { app } = makeApp();

    for (const path of ['/mcp', '/mcp/devicekey']) {
      const res = await request(app, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(initializeBody()),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toMatch(MCP_SESSION_ID_PATTERN);
    }
  });
});

describe('MCP initialize', () => {
  test('returns protocol info, capabilities and an Mcp-Session-Id', async () => {
    const { app } = makeApp();
    const { response, sessionId, body } = await initialize(app);

    expect(response.status).toBe(200);
    expect(sessionId).toMatch(MCP_SESSION_ID_PATTERN);
    expect(body?.jsonrpc).toBe('2.0');
    expect(body?.id).toBe(1);
    expect(body?.error).toBeUndefined();
    expect(body?.result.protocolVersion).toBe('2025-03-26');
    expect(body?.result.capabilities).toEqual({ tools: {} });
    expect(body?.result.serverInfo.name).toBe('Bark MCP Server');
    expect(typeof body?.result.serverInfo.version).toBe('string');
  });

  const protocolCases: Array<{ requested?: string; expected: string }> = [
    { requested: '2024-11-05', expected: '2024-11-05' },
    { requested: '2025-03-26', expected: '2025-03-26' },
    { requested: '2025-06-18', expected: '2025-06-18' },
    { requested: '2025-11-25', expected: '2025-11-25' },
    { requested: undefined, expected: '2025-03-26' },
    { requested: '', expected: '2025-03-26' },
    { requested: '2026-01-01', expected: '2025-11-25' },
  ];

  for (const { requested, expected } of protocolCases) {
    test(`negotiates protocol version '${protocolLabel(requested)}' to ${expected}`, async () => {
      const { app } = makeApp();
      const { response, sessionId, body } = await initialize(
        app,
        '/mcp',
        requested,
      );

      expect(response.status).toBe(200);
      expect(sessionId).toMatch(MCP_SESSION_ID_PATTERN);
      expect(body?.result.protocolVersion).toBe(expected);
    });
  }

  test('uses the specific server name on /mcp/:device_key', async () => {
    const { app } = makeApp();
    const device = await registerDevice(app);
    const path = `/mcp/${device.key}`;

    const { response, sessionId, body } = await initialize(app, path);
    expect(response.status).toBe(200);
    expect(sessionId).toMatch(MCP_SESSION_ID_PATTERN);
    expect(body?.result.serverInfo.name).toBe('Bark MCP Server (Specific)');
    expect(body?.result.protocolVersion).toBe('2025-03-26');
  });
});

describe('MCP sessions', () => {
  test('requires a session for non-initialize requests', async () => {
    const { app, apnsCalls } = makeApp();
    const res = await postJson(app, '/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    expect(res.status).toBe(404);
    expect((await res.text()).startsWith('Invalid session ID')).toBe(true);
    expect(apnsCalls).toHaveLength(0);
  });

  test('rejects malformed session ids', async () => {
    const { app } = makeApp();
    const malformedSessions = [
      'not-a-session',
      'mcp-session-1234',
      `mcp-session-${'z'.repeat(8)}-zzzz-zzzz-zzzz-zzzzzzzzzzzz`,
    ];

    for (const sessionId of malformedSessions) {
      const res = await sendRpc(
        app,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        sessionId,
      );
      expect(res.status).toBe(404);
      expect((await res.text()).startsWith('Invalid session ID')).toBe(true);
    }
  });

  test('accepts any well-formed, made-up session id', async () => {
    const { app } = makeApp();
    const sessionId = `mcp-session-${crypto.randomUUID()}`;

    const { response, body } = await sendRpcJson(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      sessionId,
    );
    expect(response.status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result.tools[0].name).toBe('notify');
  });
});

describe('MCP notifications', () => {
  test('acknowledges notifications with 202 and an empty body', async () => {
    const { app } = makeApp();
    const sessionId = await initializeSession(app);

    const res = await sendRpc(
      app,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId,
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('requires a session for notifications too', async () => {
    const { app } = makeApp();
    const res = await postJson(app, '/mcp', {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(res.status).toBe(404);
    expect((await res.text()).startsWith('Invalid session ID')).toBe(true);
  });
});

describe('MCP invalid bodies', () => {
  test('rejects malformed JSON with -32700 and id null', async () => {
    const { app } = makeApp();
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,',
    });

    expect(res.status).toBe(400);
    const body = await jsonBody<JsonRpcResponse>(res);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error?.code).toBe(-32700);
    expect(body.error?.message).toBe('request body is not valid json');
  });

  test('rejects JSON arrays with -32700 and id null', async () => {
    const { app } = makeApp();
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });

    expect(res.status).toBe(400);
    const body = await jsonBody<JsonRpcResponse>(res);
    expect(body.id).toBeNull();
    expect(body.error?.code).toBe(-32700);
    expect(body.error?.message).toBe('request body is not valid json');
  });

  test('rejects non-2.0 jsonrpc versions with -32600', async () => {
    const { app } = makeApp();
    const sessionId = await initializeSession(app);

    const { response, body } = await sendRpcJson(
      app,
      { jsonrpc: '1.0', id: 9, method: 'tools/list' },
      sessionId,
    );
    expect(response.status).toBe(200);
    expect(body.id).toBe(9);
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32600);
    expect(body.error?.message).toBe('Invalid JSON-RPC version');
  });
});

describe('MCP tools/list', () => {
  test('exposes the notify tool with its input schema on /mcp', async () => {
    const { app } = makeApp();
    const sessionId = await initializeSession(app);

    const { response, body } = await sendRpcJson(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      sessionId,
    );
    expect(response.status).toBe(200);
    expect(body.error).toBeUndefined();

    const tools = body.result.tools;
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe('notify');
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.required).toEqual(['device_key']);
    expect(tool.inputSchema.properties.device_key.type).toBe('string');

    const properties = tool.inputSchema.properties;
    expect(properties.level.enum).toEqual([
      'critical',
      'active',
      'timeSensitive',
      'passive',
    ]);
    expect(properties.volume.type).toBe('number');
    expect(properties.volume.default).toBe(5);
    expect(properties.volume.minimum).toBe(0);
    expect(properties.volume.maximum).toBe(10);
    expect(properties.ttl.type).toBe('number');
    expect(properties.isArchive.type).toBe('string');
    expect(properties.call.type).toBe('string');
  });

  test('omits device_key on /mcp/:device_key', async () => {
    const { app } = makeApp();
    const device = await registerDevice(app);
    const path = `/mcp/${device.key}`;
    const sessionId = await initializeSession(app, path);

    const { response, body } = await sendRpcJson(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      sessionId,
      path,
    );
    expect(response.status).toBe(200);
    expect(body.error).toBeUndefined();

    expect(body.result.tools).toHaveLength(1);
    const tool = body.result.tools[0];
    expect(tool.name).toBe('notify');
    expect(tool.inputSchema.required).toEqual([]);
    expect(tool.inputSchema.properties.device_key).toBeUndefined();
  });
});

describe('MCP tools/call notify', () => {
  test('returns an error result for invalid arguments formats', async () => {
    const { app, apnsCalls } = makeApp();
    const sessionId = await initializeSession(app);
    const variants = [
      { name: 'notify' },
      { name: 'notify', arguments: null },
      { name: 'notify', arguments: [] },
    ];

    for (const params of variants) {
      const { response, body } = await sendRpcJson(
        app,
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params },
        sessionId,
      );
      expect(response.status).toBe(200);
      expect(body.result.isError).toBe(true);
      expect(body.result.content).toEqual([
        { type: 'text', text: 'Invalid arguments format' },
      ]);
    }
    expect(apnsCalls).toHaveLength(0);
  });

  test('requires device_key on the generic endpoint', async () => {
    const { app, apnsCalls } = makeApp();
    const sessionId = await initializeSession(app);

    const { body } = await sendRpcJson(
      app,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'notify', arguments: { body: 'no key' } },
      },
      sessionId,
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content).toEqual([
      { type: 'text', text: 'device_key is required' },
    ]);
    expect(apnsCalls).toHaveLength(0);
  });

  test('sends a notification through APNs', async () => {
    const { app, apnsCalls } = makeApp();
    const device = await registerDevice(app);
    const sessionId = await initializeSession(app);

    const { response, body } = await sendRpcJson(
      app,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'notify',
          arguments: { device_key: device.key, body: 'hello from mcp' },
        },
      },
      sessionId,
    );

    expect(response.status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content).toEqual([
      { type: 'text', text: 'Notification sent successfully' },
    ]);
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0].url).toBe(`https://api.test/3/device/${device.token}`);
    expect(apnsCalls[0].body.aps.alert.body).toBe('hello from mcp');
  });

  test('maps notification arguments into the APNs payload', async () => {
    const { app, apnsCalls } = makeApp();
    const device = await registerDevice(app);
    const sessionId = await initializeSession(app);

    const { body } = await sendRpcJson(
      app,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'notify',
          arguments: {
            device_key: device.key,
            title: 'Title',
            subtitle: 'Subtitle',
            body: 'Body',
            sound: 'minuet',
            group: 'group-1',
            isArchive: '1',
            ttl: 3600,
            markdown: '**bold**',
            icon: 'https://example.com/icon.png',
            image: 'https://example.com/image.png',
            url: 'https://example.com',
            copy: 'copy-me',
            level: 'timeSensitive',
            volume: 5,
            badge: 3,
            call: '1',
          },
        },
      },
      sessionId,
    );

    expect(body.result.isError).toBeUndefined();
    expect(apnsCalls).toHaveLength(1);

    const payload = apnsCalls[0].body;
    expect(payload.aps.alert).toEqual({
      title: 'Title',
      subtitle: 'Subtitle',
      body: 'Body',
    });
    expect(payload.aps.sound).toBe('minuet.caf');
    expect(payload.aps['thread-id']).toBe('group-1');
    expect(payload.group).toBe('group-1');
    expect(payload.isarchive).toBe('1');
    expect(payload.ttl).toBe('3600');
    expect(payload.markdown).toBe('**bold**');
    expect(payload.icon).toBe('https://example.com/icon.png');
    expect(payload.image).toBe('https://example.com/image.png');
    expect(payload.url).toBe('https://example.com');
    expect(payload.copy).toBe('copy-me');
    expect(payload.level).toBe('timeSensitive');
    expect(payload.volume).toBe('5');
    expect(payload.badge).toBe('3');
    expect(payload.call).toBe('1');
  });

  test('overrides arguments.device_key with the URL key on /mcp/:device_key', async () => {
    const { app, apnsCalls } = makeApp();
    const urlDevice = await registerDevice(app);
    const otherDevice = await registerDevice(app);
    const path = `/mcp/${urlDevice.key}`;
    const sessionId = await initializeSession(app, path);

    const first = await sendRpcJson(
      app,
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'notify',
          arguments: { device_key: otherDevice.key, body: 'first' },
        },
      },
      sessionId,
      path,
    );
    expect(first.response.status).toBe(200);
    expect(first.body.result.content).toEqual([
      { type: 'text', text: 'Notification sent successfully' },
    ]);

    const second = await sendRpcJson(
      app,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'notify', arguments: { body: 'second' } },
      },
      sessionId,
      path,
    );
    expect(second.response.status).toBe(200);
    expect(second.body.result.content).toEqual([
      { type: 'text', text: 'Notification sent successfully' },
    ]);

    expect(apnsCalls).toHaveLength(2);
    expect(apnsCalls[0].url).toBe(
      `https://api.test/3/device/${urlDevice.token}`,
    );
    expect(apnsCalls[1].url).toBe(
      `https://api.test/3/device/${urlDevice.token}`,
    );
    expect(
      apnsCalls.every((call) => !call.url.endsWith(otherDevice.token)),
    ).toBe(true);
  });

  test('reports APNs failures for unknown device keys', async () => {
    const { app, apnsCalls } = makeApp();
    const sessionId = await initializeSession(app);

    const { response, body } = await sendRpcJson(
      app,
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'notify',
          arguments: { device_key: 'missingkey', body: 'fail' },
        },
      },
      sessionId,
    );

    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0].text as string;
    expect(text.startsWith('Failed to send notification:')).toBe(true);
    expect(text.endsWith('(code 400)')).toBe(true);
    expect(apnsCalls).toHaveLength(0);
  });

  test('returns -32602 for unknown tool names', async () => {
    const { app, apnsCalls } = makeApp();
    const sessionId = await initializeSession(app);

    const { response, body } = await sendRpcJson(
      app,
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'nope', arguments: { device_key: 'whatever' } },
      },
      sessionId,
    );

    expect(response.status).toBe(200);
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain("tool 'nope' not found");
    expect(apnsCalls).toHaveLength(0);
  });
});

describe('MCP HTTP methods', () => {
  const methodCases: Array<{ method: string; status: number }> = [
    { method: 'GET', status: 405 },
    { method: 'DELETE', status: 200 },
    { method: 'HEAD', status: 200 },
    { method: 'PUT', status: 404 },
    { method: 'OPTIONS', status: 404 },
  ];

  for (const { method, status } of methodCases) {
    test(`${method} /mcp returns ${status}`, async () => {
      const { app } = makeApp();
      const res = await request(app, '/mcp', { method });

      expect(res.status).toBe(status);
      if (method === 'DELETE') {
        expect(await res.text()).toBe('');
      }
    });
  }
});

describe('MCP Basic Auth', () => {
  test('rejects unauthorized initialize requests and accepts authorized ones', async () => {
    const { app, authHeader } = makeApp({ basicAuth: 'user:pass' });
    expect(authHeader).toBe(basicAuthHeader('user:pass'));

    const unauthorized = await postJson(app, '/mcp', initializeBody());
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).toBe('Unauthorized');
    expect(unauthorized.headers.get('www-authenticate')).toBe('Basic');

    const authorized = await postJson(app, '/mcp', initializeBody(), {
      authorization: authHeader as string,
    });
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('mcp-session-id')).toMatch(
      MCP_SESSION_ID_PATTERN,
    );
  });
});

describe('MCP urlPrefix', () => {
  test('serves MCP under the prefix and not at the root', async () => {
    const { app } = makeApp({ urlPrefix: '/bark' });

    const { response, sessionId } = await initialize(app, '/bark/mcp');
    expect(response.status).toBe(200);
    expect(sessionId).toMatch(MCP_SESSION_ID_PATTERN);

    const list = await sendRpc(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      sessionId as string,
      '/bark/mcp',
    );
    expect(list.status).toBe(200);

    const unprefixed = await postJson(app, '/mcp', initializeBody());
    expect(unprefixed.status).toBe(404);
  });
});
