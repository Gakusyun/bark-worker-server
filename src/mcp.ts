import type { API, PushParameters } from './api';

const BUILD_VERSION =
  typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev';

// Protocol revisions this server can speak. When the client asks for one of
// these we echo it back, otherwise we reply with our latest revision.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_NAME = 'bark-server';
const NOTIFY_TOOL_NAME = 'notify';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, any>;
}

interface JsonRpcError {
  code: number;
  message: string;
}

const errorResponse = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message } satisfies JsonRpcError,
});

const resultResponse = (id: JsonRpcId, result: any) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result,
});

const notifyTool = (fixedDeviceKey?: string) => ({
  name: NOTIFY_TOOL_NAME,
  description: 'Send a push notification to a Bark device',
  inputSchema: {
    type: 'object',
    properties: {
      ...(fixedDeviceKey
        ? {}
        : {
            device_key: {
              type: 'string',
              description: 'The device key to send the notification to',
            },
          }),
      title: { type: 'string', description: 'Notification title' },
      subtitle: { type: 'string', description: 'Notification subtitle' },
      body: { type: 'string', description: 'Notification body' },
      markdown: { type: 'string', description: 'Markdown notification body' },
      level: {
        type: 'string',
        description: 'Notification interruption level',
        enum: ['active', 'timeSensitive', 'passive', 'critical'],
      },
      volume: {
        type: 'number',
        description: 'Notification sound volume (0-10)',
      },
      badge: { type: 'number', description: 'App badge number' },
      call: {
        type: 'boolean',
        description: 'Repeat the notification sound',
      },
      sound: { type: 'string', description: 'Notification sound name' },
      icon: { type: 'string', description: 'Notification icon URL' },
      image: { type: 'string', description: 'Notification image URL' },
      group: { type: 'string', description: 'Notification group' },
      isArchive: {
        type: 'boolean',
        description: 'Archive the notification',
      },
      ttl: {
        type: 'number',
        description: 'Notification time to live in seconds',
      },
      url: {
        type: 'string',
        description: 'URL to open when the notification is tapped',
      },
      copy: {
        type: 'string',
        description: 'Text to copy when the notification is tapped',
      },
    },
    required: fixedDeviceKey ? [] : ['device_key'],
  },
});

const callNotify = async (
  api: API,
  args: Record<string, any>,
  fixedDeviceKey?: string,
) => {
  const parameters: PushParameters = { ...args };
  if (fixedDeviceKey) {
    parameters.device_key = fixedDeviceKey;
  }
  if (!parameters.device_key) {
    return {
      content: [{ type: 'text', text: 'device_key is required' }],
      isError: true,
    };
  }

  try {
    const result = await api.push(parameters);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }
};

const handleRequest = async (
  request: JsonRpcRequest,
  api: API,
  fixedDeviceKey?: string,
) => {
  const id = request.id ?? null;

  switch (request.method) {
    case 'initialize': {
      const requested = request.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return resultResponse(id, {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: BUILD_VERSION,
        },
      });
    }
    case 'ping':
      return resultResponse(id, {});
    case 'tools/list':
      return resultResponse(id, {
        tools: [notifyTool(fixedDeviceKey)],
      });
    case 'tools/call': {
      const name = request.params?.name;
      if (name !== NOTIFY_TOOL_NAME) {
        return errorResponse(id, -32602, `unknown tool: ${String(name)}`);
      }
      const args = request.params?.arguments;
      if (args !== undefined && (typeof args !== 'object' || args === null)) {
        return errorResponse(id, -32602, 'invalid tool arguments');
      }
      return resultResponse(
        id,
        await callNotify(api, args ?? {}, fixedDeviceKey),
      );
    }
    default:
      return errorResponse(
        id,
        -32601,
        `method not found: ${String(request.method)}`,
      );
  }
};

/**
 * Handle a JSON-RPC message posted to the MCP endpoint. Returns undefined for
 * notifications (which must be answered with 202 Accepted and an empty body).
 */
export const handleMcpRequest = async (
  message: any,
  api: API,
  fixedDeviceKey?: string,
): Promise<any | undefined> => {
  if (Array.isArray(message)) {
    const responses = await Promise.all(
      message.map((item) => handleMcpRequest(item, api, fixedDeviceKey)),
    );
    const nonEmpty = responses.filter((item) => item !== undefined);
    return nonEmpty.length > 0 ? nonEmpty : undefined;
  }

  if (
    !message ||
    typeof message !== 'object' ||
    typeof message.method !== 'string'
  ) {
    return errorResponse(
      message && typeof message === 'object' ? (message.id ?? null) : null,
      -32600,
      'invalid request',
    );
  }

  // JSON-RPC notifications have no id and must not receive a response
  if (message.id === undefined) {
    return undefined;
  }

  try {
    return await handleRequest(message, api, fixedDeviceKey);
  } catch (e) {
    const messageText = e instanceof Error ? e.message : String(e);
    return errorResponse(message.id, -32603, messageText);
  }
};

export const MCP_ENDPOINT = '/mcp';
