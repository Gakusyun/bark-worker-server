# MCP

Bark Worker Server 实现了 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的 **Streamable HTTP** 端点，可供 Claude Desktop、Cherry Studio、n8n 等 AI 客户端直接发送 Bark 通知。

由于部署在阿里云 ESA 边缘函数上，本服务**只返回普通 JSON 响应，不启用 SSE 流式传输**。客户端需要使用 Streamable HTTP 的 JSON 响应模式，不能使用只支持 SSE 的配置。

## 端点

两个端点均相对于 `URL_PREFIX`：

| 端点 | 说明 |
| --- | --- |
| `POST /mcp` | 通用端点。`notify` 工具的参数中必须包含 `device_key`。 |
| `POST /mcp/:device_key` | 设备专用端点。`device_key` 固定在 URL 中，工具 schema 不再包含该参数；即使调用时传了 `device_key`，也会被 URL 中的值覆盖。 |

完整地址形如：

```text
https://<域名><URL_PREFIX>/mcp
https://<域名><URL_PREFIX>/mcp/<device_key>
```

例如 `URL_PREFIX=/bark` 时：

```text
https://bark.example.com/bark/mcp
https://bark.example.com/bark/mcp/xxxxxxxxxxxxxxxxxxxxxx
```

`URL_PREFIX` 默认为根路径，此时地址为 `https://bark.example.com/mcp/<device_key>`。

## HTTP 传输行为

| 方法 | 行为 |
| --- | --- |
| `POST` | 处理 JSON-RPC 请求。要求 `Content-Type: application/json`（或 `application/*+json`）。 |
| `GET` | HTTP 405，纯文本 `Streaming is disabled on this server`（SSE 未启用）。 |
| `DELETE` | HTTP 200，响应体为空（用于结束会话）。 |
| `HEAD` | HTTP 200，响应体为空。 |
| 其他 | HTTP 404，纯文本 `404 page not found`。 |

POST 相关的约定：

- `Content-Type` 不是 JSON 时返回 HTTP 400，纯文本：`Invalid content type: must be 'application/json'`。
- 请求体必须是**单个 JSON 对象**。非法 JSON、`null`、数组（包括 JSON-RPC batch）都会返回 HTTP 400：

  ```json
  {
    "jsonrpc": "2.0",
    "id": null,
    "error": {"code": -32700, "message": "request body is not valid json"}
  }
  ```

- 服务端不要求客户端发送 `Accept: text/event-stream`；POST 的 JSON-RPC 响应统一为 `application/json`。
- `initialize` 正常返回时，响应头包含 `Mcp-Session-Id`；这是后续请求必须携带的会话 ID。
- JSON-RPC 层面的错误（如未知方法、未知工具）通常仍返回 HTTP 200，错误信息放在响应体的 `error` 字段中；只有解析失败、会话无效、Content-Type 错误等传输层错误才使用 400/404。

## 会话（Mcp-Session-Id）

1. 客户端首先发送 `initialize` 请求。`initialize` 本身不需要会话 ID。
2. 服务端在 `initialize` 响应头中返回：

   ```http
   Mcp-Session-Id: mcp-session-3f1c2a7e-8b4d-4c1a-9e2f-1a2b3c4d5e6f
   ```

3. 之后发往 MCP 端点的 JSON-RPC 请求（`tools/list`、`tools/call`、`notifications/initialized` 等）都必须携带该请求头：

   ```http
   Mcp-Session-Id: mcp-session-3f1c2a7e-8b4d-4c1a-9e2f-1a2b3c4d5e6f
   ```

4. 缺少会话 ID，或格式不是 `mcp-session-<UUID>` 时，返回 HTTP 404，纯文本 `Invalid session ID`。

其他约定：

- 服务端只校验 `Mcp-Session-Id` 的格式，不保存会话状态，也不校验它是否由本服务端签发。`DELETE` 返回 200，但不会在服务端留下需要清理的会话。
- 所有**没有 `id` 的 JSON-RPC 通知**（包括 `notifications/initialized`）都返回 HTTP 202，响应体为空。通知同样需要会话 ID。
- 客户端回传的 JSON-RPC response（没有 `method`，包含 `id` 和 `result`/`error`）会被接受并返回 202，不要求会话 ID。
- 发送 `initialize` 时请带上 `id`；如果 `initialize` 没有 `id`，它会被当作通知处理，返回 202 且不会返回 `Mcp-Session-Id`。

## 协议版本

`initialize` 会协商 MCP 协议版本：

- 支持 `2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25`；客户端请求这些版本时，服务端原样返回。
- 未提供 `protocolVersion` 时，默认返回 `2025-03-26`。
- 请求了不支持的版本时，回落到 `2025-11-25`。

`initialize` 结果示例：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-03-26",
    "capabilities": {"tools": {}},
    "serverInfo": {
      "name": "Bark MCP Server (Specific)",
      "version": "v2.4.0"
    }
  }
}
```

- `serverInfo.name`：通用端点为 `Bark MCP Server`，设备专用端点为 `Bark MCP Server (Specific)`。
- `serverInfo.version`：构建时注入的版本号，形如 `v2.4.0`。
- 服务端只声明 `tools` 能力，不提供 resources、prompts 等能力。

## 认证

启用 `BASIC_AUTH` 后，**所有 MCP 请求**（包括 `POST`、`GET`、`DELETE`、`HEAD`）都需要携带：

```http
Authorization: Basic base64("用户名:密码")
```

例如 `BASIC_AUTH=user:password` 时：

```http
Authorization: Basic dXNlcjpwYXNzd29yZA==
```

说明：

- `BASIC_AUTH` 是单个 `用户名:密码` 字符串；使用 curl 时可以直接写 `-u user:password`。
- 认证失败返回 HTTP 401，纯文本 `Unauthorized`，并带有 `WWW-Authenticate: Basic`。
- 启用认证时，认证检查先于 MCP 方法检查；因此未带凭证的 `GET /mcp` 会先得到 401，而不是 405。
- `/ping`、`/register`（及其子路径）、`/healthz`、`/` 不需要认证；MCP 端点不在白名单内。
- 本服务**不支持**通过查询参数传递凭证（例如 `?user=...&password=...`）。如果客户端无法发送自定义请求头，只能关闭 `BASIC_AUTH`，或通过可信的前置代理注入 `Authorization` 请求头。

## notify 工具

服务端只提供一个工具 `notify`，用于发送单条通知。

- 描述：`Send a notification to a device via Bark`
- 注解（annotations）：`readOnlyHint: false`、`destructiveHint: true`、`idempotentHint: false`、`openWorldHint: true`
- 仅支持单设备推送，不会触发批量 `device_keys` 逻辑。

### 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `device_key` | string | 设备 key。通用端点 `/mcp` 中必填；设备专用端点 `/mcp/:device_key` 的 schema 中不包含此参数，URL 中的值优先。 |
| `title` | string | 通知标题 |
| `subtitle` | string | 通知副标题 |
| `body` | string | 通知正文 |
| `markdown` | string | Markdown 正文。工具描述中写作“Overrides body”，但服务端**不会**修改 `body`，只把 `markdown` 作为扩展字段透传，由客户端处理。 |
| `level` | string | 通知级别，枚举：`critical`、`active`、`timeSensitive`、`passive` |
| `volume` | number | critical 通知音量，范围 0–10，schema 默认 5；服务端不校验、也不自动补默认值 |
| `badge` | number | App 图标角标数字 |
| `call` | string | 值为 `"1"` 时客户端循环响铃 30 秒 |
| `sound` | string | 通知铃声 |
| `icon` | string | 通知图标 URL，仅 iOS 15 及以上支持 |
| `image` | string | 通知图片 URL |
| `group` | string | 通知分组 |
| `isArchive` | string | 值为 `"1"` 时客户端归档通知，其他值不归档 |
| `ttl` | number | 归档消息保留秒数；仅作为扩展字段透传，不会修改 APNs expiration（固定为当前时间 + 24 小时） |
| `url` | string | 点击通知后跳转的 URL |
| `copy` | string | 点击复制时复制的文本 |

参数说明：

- 通用端点中 `required` 只有 `device_key`；其他参数均可选。
- 所有字符串类型的特殊值（如 `call`、`isArchive`）都应传字符串 `"1"`，传布尔值 `true` 会被转换为 `"true"`。
- 服务端不校验 `level`、`volume` 等枚举或范围，schema 中的约束仅供客户端参考。

### 未声明的参数

工具 schema 只列出常用参数，但调用时传入的**其他参数会原样进入推送逻辑**，例如：

- `autoCopy` / `autocopy`
- `action`
- `ciphertext`
- `iv`
- `id`
- `delete`
- `ext_params`
- 任意自定义字段

处理规则与 HTTP 推送接口一致：键名转为小写、值转为字符串写入 APNs payload；`ext_params` 以及任意对象值参数会被展开为顶层字段。

例如可以通过未声明的 `delete: true` 发送静默推送。`device_keys` 不会触发批量推送；MCP 始终按单设备处理。

### 返回结果

工具执行结果通过 MCP `content` 返回，HTTP 状态码仍为 200：

| 情况 | 返回 |
| --- | --- |
| 发送成功 | `content[0].text` 为 `Notification sent successfully` |
| 发送失败 | `isError: true`，`content[0].text` 为 `Failed to send notification: <message> (code <code>)` |
| `arguments` 不是对象 | `isError: true`，`content[0].text` 为 `Invalid arguments format` |
| 通用端点缺少 `device_key` | `isError: true`，`content[0].text` 为 `device_key is required` |
| 工具名不是 `notify` | JSON-RPC error，`code` 为 `-32602` |

成功示例：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {"type": "text", "text": "Notification sent successfully"}
    ]
  }
}
```

失败示例：

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Failed to send notification: failed to get device token: failed to get [badkey] device token from database (code 400)"
      }
    ],
    "isError": true
  }
}
```

## 客户端配置

下面以 `URL_PREFIX=/bark`、服务地址 `https://bark.example.com/bark` 为例。请替换为自己的域名、`URL_PREFIX` 和 `device_key`。

启用 `BASIC_AUTH` 时，所有配置都需要增加请求头：

```text
Authorization: Basic base64("用户名:密码")
```

例如 `user:password` 对应 `Basic dXNlcjpwYXNzd29yZA==`。未启用 `BASIC_AUTH` 时删除该请求头即可。

### Cherry Studio

```json
{
  "mcpServers": {
    "bark": {
      "type": "streamableHttp",
      "url": "https://bark.example.com/bark/mcp/<device_key>",
      "headers": {
        "Authorization": "Basic dXNlcjpwYXNzd29yZA=="
      }
    }
  }
}
```

### Claude Desktop

支持远程 HTTP MCP 的版本可以在 `claude_desktop_config.json` 中直接配置：

```json
{
  "mcpServers": {
    "bark": {
      "type": "http",
      "url": "https://bark.example.com/bark/mcp/<device_key>",
      "headers": {
        "Authorization": "Basic dXNlcjpwYXNzd29yZA=="
      }
    }
  }
}
```

如果 Claude Desktop 版本只支持 stdio MCP，可以用 `mcp-remote` 之类的桥接工具转发，并通过参数携带认证头：

```json
{
  "mcpServers": {
    "bark": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://bark.example.com/bark/mcp/<device_key>",
        "--header",
        "Authorization: Basic dXNlcjpwYXNzd29yZA=="
      ]
    }
  }
}
```

请确保桥接工具使用 Streamable HTTP（而不是只尝试 SSE），并且能携带自定义请求头。

### n8n

使用 n8n 的 **MCP Client Tool** 节点（选择 HTTP Streamable / Streamable HTTP 传输）时：

- URL：`https://bark.example.com/bark/mcp/<device_key>`
- Authentication：Header Auth
  - Name：`Authorization`
  - Value：`Basic dXNlcjpwYXNzd29yZA==`

n8n 会自行完成 `initialize` 和 `Mcp-Session-Id` 管理。如果改用 **HTTP Request** 节点手动调用，需要先发送 `initialize`，从响应头取出 `Mcp-Session-Id`，再在后续请求的 Header 中带上；详见下方的 curl 示例。

### 其他客户端

VS Code：

```json
{
  "servers": {
    "bark": {
      "type": "http",
      "url": "https://bark.example.com/bark/mcp/<device_key>",
      "headers": {
        "Authorization": "Basic dXNlcjpwYXNzd29yZA=="
      }
    }
  }
}
```

Claude Code：

```sh
claude mcp add bark --transport http https://bark.example.com/bark/mcp/<device_key> \
  --header "Authorization: Basic dXNlcjpwYXNzd29yZA=="
```

## curl / JSON-RPC 示例

以下示例假设：

```sh
BASE="https://bark.example.com/bark"
KEY="xxxxxxxxxxxxxxxxxxxxxx"
AUTH="Authorization: Basic dXNlcjpwYXNzd29yZA=="   # 未启用 BASIC_AUTH 时删除 -H "$AUTH"
```

### 1. initialize

```sh
curl -i -X POST "$BASE/mcp/$KEY" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "curl", "version": "1.0.0"}
    }
  }'
```

响应示例：

```http
HTTP/1.1 200 OK
Content-Type: application/json
Mcp-Session-Id: mcp-session-3f1c2a7e-8b4d-4c1a-9e2f-1a2b3c4d5e6f

{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"Bark MCP Server (Specific)","version":"v2.4.0"}}}
```

记下响应头中的 `Mcp-Session-Id`，后续请求都要带上：

```sh
SESSION="mcp-session-3f1c2a7e-8b4d-4c1a-9e2f-1a2b3c4d5e6f"
```

### 2. notifications/initialized

```sh
curl -i -X POST "$BASE/mcp/$KEY" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION" \
  -H "$AUTH" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
```

返回 HTTP 202，无响应体。

### 3. tools/list

```sh
curl -s -X POST "$BASE/mcp/$KEY" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION" \
  -H "$AUTH" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

设备专用端点返回的 `notify` schema 不包含 `device_key`，`required` 为空数组；通用端点 `/mcp` 的 schema 会包含 `device_key`，且 `required` 为 `["device_key"]`。

### 4. tools/call（设备专用端点）

```sh
curl -s -X POST "$BASE/mcp/$KEY" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION" \
  -H "$AUTH" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "notify",
      "arguments": {
        "title": "构建完成",
        "body": "bark-worker-server 已部署",
        "level": "active",
        "sound": "minuet",
        "group": "CI",
        "isArchive": "1",
        "ttl": 86400,
        "url": "https://example.com"
      }
    }
  }'
```

### 5. tools/call（通用端点）

```sh
curl -s -X POST "$BASE/mcp" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $SESSION" \
  -H "$AUTH" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "notify",
      "arguments": {
        "device_key": "xxxxxxxxxxxxxxxxxxxxxx",
        "title": "Hello",
        "body": "from generic /mcp"
      }
    }
  }'
```

### 6. GET / DELETE

```sh
# SSE 未启用：返回 405
curl -i -X GET "$BASE/mcp/$KEY" -H "$AUTH"

# 结束会话：返回 200，无响应体
curl -i -X DELETE "$BASE/mcp/$KEY" \
  -H "Mcp-Session-Id: $SESSION" \
  -H "$AUTH"
```

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| HTTP 401，纯文本 `Unauthorized` | 启用 `BASIC_AUTH` 但未携带正确的 `Authorization` 头 |
| HTTP 400，`Invalid content type: must be 'application/json'` | POST 请求没有设置 `Content-Type: application/json` |
| HTTP 404，`Invalid session ID` | `initialize` 之后没有携带 `Mcp-Session-Id`，或格式不正确 |
| HTTP 405，`Streaming is disabled on this server` | 客户端尝试用 GET/SSE 建流；应改用 Streamable HTTP 的 JSON 响应模式 |
| HTTP 202，无响应体 | 收到的是通知（没有 `id`），属于正常行为 |
| HTTP 400，JSON-RPC `-32700` | 请求体不是单个 JSON 对象（例如使用了 JSON-RPC batch 数组） |
| 工具结果 `isError: true` | 推送失败，查看文本中的错误信息和 `code`（与 HTTP API 的错误码一致） |

## 不支持的能力

服务端只实现工具调用，以下 MCP 能力会返回 JSON-RPC error `-32601`：

| 方法 | 错误信息 |
| --- | --- |
| `resources/list`、`resources/templates/list`、`resources/read`、`resources/subscribe`、`resources/unsubscribe` | `resources not supported` |
| `prompts/list`、`prompts/get` | `prompts not supported` |
| `logging/setLevel` | `logging not supported` |
| `completion/complete` | `completions not supported` |
| `tasks/get`、`tasks/list`、`tasks/result`、`tasks/cancel` | `tasks not supported` |
| `server/discover`、`subscriptions/listen` | `requires protocol version 2026-07-28 or later` |
| 其他未知方法 | `Method <method> not found` |
