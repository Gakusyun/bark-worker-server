import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { API, APIError } from './api';
import { handleMcpRequest } from './mcp';
import type { Options } from './type';
import { getTimestamp, validateBasicAuth } from './utils';

const parseParam = (t: string) => {
  try {
    return decodeURIComponent(t.replaceAll('\\+', '%20'));
  } catch {
    throw new APIError(400, 'url path parse failed');
  }
};

const parseBody = async <T = Record<string, any>>(c: Context): Promise<T> => {
  const isJSON = c.req.header('Content-Type')?.startsWith('application/json');
  return isJSON ? await c.req.json() : ((await c.req.parseBody()) as T);
};

const lowerCaseKeys = (source: Record<string, any>) => {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(source || {})) {
    result[key.toLowerCase()] = value;
  }
  return result;
};

const parseQuery = (c: Context) => lowerCaseKeys(c.req.query());

const parseBodyParams = async (c: Context) =>
  lowerCaseKeys(await parseBody<Record<string, any>>(c));

const parsePath = (c: Context, keys: string[]) => {
  const result: Record<string, any> = {};
  for (const key of keys) {
    const value = c.req.param(key);
    if (value !== undefined) {
      result[key] = parseParam(value);
    }
  }
  return result;
};

const registerV1 = async (app: Hono, api: API) => {
  app.get('/:device_key', async (c) =>
    c.json(
      await api.push({
        ...parseQuery(c),
        ...parsePath(c, ['device_key']),
      }),
    ),
  );
  app.post('/:device_key', async (c) =>
    c.json(
      await api.push({
        ...parseQuery(c),
        ...(await parseBodyParams(c)),
        ...parsePath(c, ['device_key']),
      }),
    ),
  );

  app.get('/:device_key/:body', async (c) =>
    c.json(
      await api.push({
        ...parseQuery(c),
        ...parsePath(c, ['device_key', 'body']),
      }),
    ),
  );
  app.post('/:device_key/:body', async (c) =>
    c.json(
      await api.push({
        ...parseQuery(c),
        ...(await parseBodyParams(c)),
        ...parsePath(c, ['device_key', 'body']),
      }),
    ),
  );

  app.get('/:device_key/:title/:body', async (c) =>
    c.json(
      await api.push({
        ...parseQuery(c),
        ...parsePath(c, ['device_key', 'title', 'body']),
      }),
    ),
  );
  app.post('/:device_key/:title/:body', async (c) =>
    c.json(
      await api.push({
        ...parseQuery(c),
        ...(await parseBodyParams(c)),
        ...parsePath(c, ['device_key', 'title', 'body']),
      }),
    ),
  );

  app.get('/:device_key/:title/:subtitle/:body', async (c) =>
    c.json(
      await api.push({
        ...parseQuery(c),
        ...parsePath(c, ['device_key', 'title', 'subtitle', 'body']),
      }),
    ),
  );
  app.post('/:device_key/:title/:subtitle/:body', async (c) =>
    c.json(
      await api.push({
        ...parseQuery(c),
        ...(await parseBodyParams(c)),
        ...parsePath(c, ['device_key', 'title', 'subtitle', 'body']),
      }),
    ),
  );
};

// same as upstream: these paths stay public when Basic Auth is enabled
const AUTH_WHITELIST = ['/ping', '/register', '/healthz'];

const normalizeUrlPrefix = (prefix?: string) =>
  (prefix || '').replace(/\/+$/, '');

const isAuthWhitelisted = (path: string) =>
  AUTH_WHITELIST.some((p) => path === p || path.startsWith(`${p}/`));

export const createHono = (options: Options) => {
  const api = new API(options);

  const app = new Hono();

  const router = app.basePath(options.urlPrefix || '/');

  const urlPrefix = normalizeUrlPrefix(options.urlPrefix);

  router.use('*', async (c, next) => {
    const path =
      urlPrefix && c.req.path.startsWith(urlPrefix)
        ? c.req.path.slice(urlPrefix.length) || '/'
        : c.req.path;
    if (isAuthWhitelisted(path)) {
      return next();
    }
    if (!validateBasicAuth(c.req.header('Authorization'), options.basicAuth)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: {
          'content-type': 'text/plain',
          'WWW-Authenticate': 'Basic',
        },
      });
    }
    return next();
  });

  router.get('/register', async (c) => {
    return c.json(
      await api.register(
        c.req.query('device_token') || c.req.query('devicetoken'),
        c.req.query('device_key') || c.req.query('key'),
        c.req.query('device_type') || c.req.query('devicetype'),
      ),
    );
  });

  router.post('/register', async (c) => {
    const body = await parseBody(c);
    return c.json(
      await api.register(
        body.device_token || body.devicetoken,
        body.device_key || body.key,
        body.device_type || body.devicetype,
      ),
    );
  });

  router.get('/register/:device_key', async (c) =>
    c.json(await api.checkRegister(parseParam(c.req.param('device_key')))),
  );

  router.all('/ping', (c) => c.json(api.ping()));

  router.all('/healthz', (c) => c.text('ok'));

  router.all('/info', async (c) => c.json(await api.info()));

  // base push
  router.post('/push', async (c) =>
    c.json(
      await api.push({
        ...(await parseBodyParams(c)),
        ...parseQuery(c),
      }),
    ),
  );

  // MCP (Streamable HTTP, stateless JSON responses). Must be registered
  // before the V1 catch-all routes.
  const handleMcp = (fixedDeviceKey?: string) => async (c: Context) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'parse error' },
        },
        400,
      );
    }
    const result = await handleMcpRequest(body, api, fixedDeviceKey);
    if (result === undefined) {
      return c.body(null, 202);
    }
    return c.json(result);
  };
  const rejectSse = (c: Context) => {
    c.header('Allow', 'POST');
    return c.body(null, 405);
  };

  router.post('/mcp', handleMcp());
  router.post('/mcp/:device_key', (c) =>
    handleMcp(parseParam(c.req.param('device_key')))(c),
  );
  router.get('/mcp', rejectSse);
  router.get('/mcp/:device_key', rejectSse);
  router.delete('/mcp', rejectSse);
  router.delete('/mcp/:device_key', rejectSse);

  // compat v1 API
  registerV1(router as unknown as Hono, api);

  router.all('/', (c) => c.text('ok'));

  app.onError((err, c) => {
    const errCode = err instanceof APIError ? err.code : 500;
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        code: errCode,
        message,
        timestamp: getTimestamp(),
      },
      errCode as ContentfulStatusCode,
    );
  });

  return app;
};
