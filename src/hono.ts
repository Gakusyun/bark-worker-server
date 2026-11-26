import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { API, APIError } from './api';
import { handleMcpHttp } from './mcp';
import type { Options } from './type';
import { getTimestamp, validateBasicAuth } from './utils';

const parseParam = (t: string) => {
  try {
    return decodeURIComponent(t.replaceAll('\\+', '%20'));
  } catch {
    throw new APIError(400, 'url path parse failed');
  }
};

const isJsonContentType = (c: Context) => {
  const mediaType = (c.req.header('Content-Type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
};

const parseBody = async <T = Record<string, any>>(c: Context): Promise<T> =>
  isJsonContentType(c) ? await c.req.json() : ((await c.req.parseBody()) as T);

const lowerCaseKeys = (source: Record<string, any>) => {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(source || {})) {
    result[key.toLowerCase()] = value;
  }
  return result;
};

const parseQuery = (c: Context) => lowerCaseKeys(c.req.query());

const parseBodyParams = async (c: Context) => {
  try {
    return lowerCaseKeys(await parseBody<Record<string, any>>(c));
  } catch (e) {
    if (isJsonContentType(c)) {
      throw new APIError(
        400,
        `request bind failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // upstream ignores malformed form/multipart bodies
    return {};
  }
};

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
  const pushGet = (pathKeys: string[]) => async (c: Context) =>
    c.json(
      await api.push(
        {
          ...parseQuery(c),
          ...parsePath(c, pathKeys),
        },
        { batch: false },
      ),
    );

  const pushPost = (pathKeys: string[]) => async (c: Context) => {
    const isJson = isJsonContentType(c);
    const body = await parseBodyParams(c);
    const pathParams = parsePath(c, pathKeys);
    const params = isJson
      ? { ...body, ...parseQuery(c), ...pathParams }
      : { ...parseQuery(c), ...body, ...pathParams };
    return c.json(await api.push(params, { batch: isJson }));
  };

  app.get('/:device_key', pushGet(['device_key']));
  app.post('/:device_key', pushPost(['device_key']));

  app.get('/:device_key/:body', pushGet(['device_key', 'body']));
  app.post('/:device_key/:body', pushPost(['device_key', 'body']));

  app.get(
    '/:device_key/:title/:body',
    pushGet(['device_key', 'title', 'body']),
  );
  app.post(
    '/:device_key/:title/:body',
    pushPost(['device_key', 'title', 'body']),
  );

  app.get(
    '/:device_key/:title/:subtitle/:body',
    pushGet(['device_key', 'title', 'subtitle', 'body']),
  );
  app.post(
    '/:device_key/:title/:subtitle/:body',
    pushPost(['device_key', 'title', 'subtitle', 'body']),
  );
};

// same as upstream: these paths stay public when Basic Auth is enabled.
// Upstream's middleware pattern also leaves the root path unprotected.
const AUTH_WHITELIST = ['/', '/ping', '/register', '/healthz'];

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
    const query = parseQuery(c);
    return c.json(
      await api.register(
        query.device_token || query.devicetoken,
        query.device_key || query.key,
        query.device_type || query.devicetype,
      ),
    );
  });

  router.post('/register', async (c) => {
    const contentType = (c.req.header('Content-Type') || '').toLowerCase();
    const supported =
      isJsonContentType(c) ||
      contentType.startsWith('application/x-www-form-urlencoded') ||
      contentType.startsWith('multipart/form-data');
    if (!supported) {
      throw new APIError(400, 'request bind failed2: Unprocessable Entity');
    }
    let body: Record<string, any>;
    try {
      body = lowerCaseKeys(await parseBody<Record<string, any>>(c));
    } catch (e) {
      throw new APIError(
        400,
        `request bind failed2: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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

  // base push: upstream dispatches by Content-Type, JSON uses the V2 code
  // path (body < query, batch enabled), everything else uses V1.
  router.post('/push', async (c) => {
    const isJson = isJsonContentType(c);
    const body = await parseBodyParams(c);
    const params = isJson
      ? { ...body, ...parseQuery(c) }
      : { ...parseQuery(c), ...body };
    return c.json(await api.push(params, { batch: isJson }));
  });

  // MCP (Streamable HTTP, JSON responses). Must be registered before the V1
  // catch-all routes.
  const handleMcp = (fixedDeviceKey?: string) => async (c: Context) => {
    let body: any;
    let parseError = false;
    if (c.req.method === 'POST') {
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        parseError = true;
      }
    }
    const result = await handleMcpHttp(
      {
        method: c.req.method,
        contentType: c.req.header('Content-Type'),
        sessionId: c.req.header('Mcp-Session-Id'),
        body,
        parseError,
      },
      api,
      fixedDeviceKey,
    );
    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        c.header(key, value);
      }
    }
    if (result.json !== undefined) {
      return c.json(result.json, result.status as ContentfulStatusCode);
    }
    if (result.text !== undefined) {
      return c.text(result.text, result.status as ContentfulStatusCode);
    }
    return c.body(null, result.status as ContentfulStatusCode);
  };

  router.all('/mcp', handleMcp());
  router.all('/mcp/:device_key', (c) =>
    handleMcp(parseParam(c.req.param('device_key')))(c),
  );

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
