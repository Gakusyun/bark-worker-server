import type { API, PushParameters } from './api';
import { APIError } from './api';

const BUILD_VERSION =
  typeof __BUILD_VERSION__ !== 'undefined' && __BUILD_VERSION__
    ? `v${__BUILD_VERSION__.replace(/^v/, '')}`
    : '';

// Legacy protocol revisions supported by upstream mcp-go. Requests asking for
// one of these get it echoed back, unknown values fall back to the latest
// legacy revision.
const LEGACY_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
];
const DEFAULT_LEGACY_PROTOCOL_VERSION = '2025-03-26';
const LATEST_LEGACY_PROTOCOL_VERSION = '2025-11-25';
const SESSION_ID_PREFIX = 'mcp-session-';
const SESSION_ID_PATTERN =
  /^mcp-session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTIFY_TOOL_NAME = 'notify';

type JsonRpcId = string | number | null;

export interface McpHttpRequest {
  method: string;
  contentType?: string;
  sessionId?: string;
  body?: any;
  parseError?: boolean;
}

export interface McpHttpResponse {
  status: number;
  json?: any;
  text?: string;
  headers?: Record<string, string>;
}

const errorResponse = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

const resultResponse = (id: JsonRpcId, result: any) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result,
});

const textResult = (text: string, isError = false) => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

const negotiateProtocolVersion = (requested?: unknown) => {
  if (typeof requested !== 'string' || requested === '') {
    return DEFAULT_LEGACY_PROTOCOL_VERSION;
  }
  if (LEGACY_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return LATEST_LEGACY_PROTOCOL_VERSION;
};

const notifyTool = (fixedDeviceKey?: string) => ({
  name: NOTIFY_TOOL_NAME,
  description: 'Send a notification to a device via Bark',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      ...(fixedDeviceKey
        ? {}
        : { device_key: { description: 'Device Key', type: 'string' } }),
      title: { description: 'Notification title', type: 'string' },
      subtitle: { description: 'Notification subtitle', type: 'string' },
      body: { description: 'Notification content', type: 'string' },
      markdown: {
        description: 'Basic Markdown notification content. Overrides body.',
        type: 'string',
      },
      level: {
        description: 'Notification level',
        enum: ['critical', 'active', 'timeSensitive', 'passive'],
        type: 'string',
      },
      volume: {
        default: 5,
        description: 'Alert volume for important notification',
        maximum: 10,
        minimum: 0,
        type: 'number',
      },
      badge: { description: 'Badge number', type: 'number' },
      call: {
        description: "Set to '1' to repeat the notification ringtone",
        type: 'string',
      },
      sound: { description: 'Notification sound', type: 'string' },
      icon: { description: 'Notification icon URL', type: 'string' },
      image: { description: 'Notification image URL', type: 'string' },
      group: { description: 'Notification group', type: 'string' },
      isArchive: {
        description:
          "Set to '1' to save the notification or any other value to skip saving",
        type: 'string',
      },
      ttl: {
        description:
          'Time to live in seconds for archived messages; expired items are automatically deleted',
        type: 'number',
      },
      url: { description: 'Click action URL', type: 'string' },
      copy: { description: 'Text to copy on copy action', type: 'string' },
    },
    required: fixedDeviceKey ? [] : ['device_key'],
  },
});

const callNotify = async (api: API, params: any, fixedDeviceKey?: string) => {
  const args = params?.arguments;
  if (
    args === undefined ||
    args === null ||
    typeof args !== 'object' ||
    Array.isArray(args)
  ) {
    return textResult('Invalid arguments format', true);
  }

  let deviceKey = typeof args.device_key === 'string' ? args.device_key : '';
  if (fixedDeviceKey) {
    deviceKey = fixedDeviceKey;
  }
  if (!deviceKey) {
    return textResult('device_key is required', true);
  }

  const parameters: PushParameters = { ...args, device_key: deviceKey };
  try {
    await api.push(parameters, { batch: false });
    return textResult('Notification sent successfully');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code = e instanceof APIError ? e.code : 500;
    return textResult(
      `Failed to send notification: ${message} (code ${code})`,
      true,
    );
  }
};

const handleMethod = async (
  request: any,
  api: API,
  fixedDeviceKey?: string,
) => {
  const id = request.id ?? null;
  const method = request.method;

  switch (method) {
    case 'initialize':
      return resultResponse(id, {
        protocolVersion: negotiateProtocolVersion(
          request.params?.protocolVersion,
        ),
        capabilities: { tools: {} },
        serverInfo: {
          name: fixedDeviceKey
            ? 'Bark MCP Server (Specific)'
            : 'Bark MCP Server',
          version: BUILD_VERSION,
        },
      });
    case 'ping':
      return resultResponse(id, {});
    case 'tools/list':
      return resultResponse(id, {
        tools: [notifyTool(fixedDeviceKey)],
      });
    case 'tools/call': {
      const name = request.params?.name;
      if (name !== NOTIFY_TOOL_NAME) {
        return errorResponse(
          id,
          -32602,
          `tool '${String(name)}' not found: tool not found`,
        );
      }
      return resultResponse(
        id,
        await callNotify(api, request.params, fixedDeviceKey),
      );
    }
    case 'resources/list':
    case 'resources/templates/list':
    case 'resources/read':
    case 'resources/subscribe':
    case 'resources/unsubscribe':
      return errorResponse(id, -32601, 'resources not supported');
    case 'prompts/list':
    case 'prompts/get':
      return errorResponse(id, -32601, 'prompts not supported');
    case 'logging/setLevel':
      return errorResponse(id, -32601, 'logging not supported');
    case 'completion/complete':
      return errorResponse(id, -32601, 'completions not supported');
    case 'tasks/get':
    case 'tasks/list':
    case 'tasks/result':
    case 'tasks/cancel':
      return errorResponse(id, -32601, 'tasks not supported');
    case 'server/discover':
    case 'subscriptions/listen':
      return errorResponse(
        id,
        -32601,
        'requires protocol version 2026-07-28 or later',
      );
    default:
      return errorResponse(id, -32601, `Method ${String(method)} not found`);
  }
};

const isJsonContentType = (contentType?: string) => {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
};

const isClientResponse = (message: any) =>
  message &&
  typeof message === 'object' &&
  message.method === undefined &&
  message.id !== undefined &&
  (message.result !== undefined || message.error !== undefined);

export const handleMcpHttp = async (
  request: McpHttpRequest,
  api: API,
  fixedDeviceKey?: string,
): Promise<McpHttpResponse> => {
  if (request.method === 'GET') {
    return { status: 405, text: 'Streaming is disabled on this server\n' };
  }
  if (request.method === 'DELETE') {
    return { status: 200 };
  }
  if (request.method === 'HEAD') {
    return { status: 200 };
  }
  if (request.method !== 'POST') {
    return { status: 404, text: '404 page not found\n' };
  }

  if (!isJsonContentType(request.contentType)) {
    return {
      status: 400,
      text: "Invalid content type: must be 'application/json'\n",
    };
  }

  const message = request.body;
  if (
    request.parseError ||
    message === null ||
    typeof message !== 'object' ||
    Array.isArray(message)
  ) {
    return {
      status: 400,
      json: errorResponse(null, -32700, 'request body is not valid json'),
    };
  }

  // JSON-RPC responses from the client are accepted without a session.
  if (isClientResponse(message)) {
    return { status: 202 };
  }

  const isInitialize = message.method === 'initialize';
  if (!isInitialize) {
    if (!request.sessionId || !SESSION_ID_PATTERN.test(request.sessionId)) {
      return { status: 404, text: 'Invalid session ID\n' };
    }
  }

  // Notifications never receive a response body.
  if (message.id === undefined) {
    return { status: 202 };
  }

  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return {
      status: 200,
      json: errorResponse(message.id, -32600, 'Invalid JSON-RPC version'),
    };
  }

  const result = await handleMethod(message, api, fixedDeviceKey);
  if (isInitialize) {
    return {
      status: 200,
      json: result,
      headers: {
        'Mcp-Session-Id': `${SESSION_ID_PREFIX}${crypto.randomUUID()}`,
      },
    };
  }
  return { status: 200, json: result };
};
