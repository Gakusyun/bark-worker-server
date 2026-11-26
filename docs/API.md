# Bark Worker Server API 参考

Bark Worker Server 是 [Finb/bark-server](https://github.com/Finb/bark-server) 的 TypeScript/Hono 移植，运行在阿里云 ESA 边缘函数上，兼容 Bark API V1 / V2。本文档以本仓库的实际实现为准，并标注了与上游行为不同的地方。

## 基础约定

- 服务地址：`https://<域名><URL_PREFIX>`，下文中记为 `<base>`。`URL_PREFIX` 默认为根路径 `/`；例如部署到 `/bark` 时，App 中填写的服务器地址为 `https://bark.example.com/bark`。`URL_PREFIX` 开头必须带 `/`，末尾不要带 `/`。
- 下文所有接口路径都相对于 `<base>`。
- 参数名大小写不敏感，服务端会统一转换为小写。
- 参数可以放在 JSON body、表单 body 或 query string 中；V1 兼容路由还支持放在 URL path 中。
- `timestamp` 为 Unix 时间戳（秒）；`/info` 返回的 `time` 是毫秒时间戳。
- `/` 和 `/healthz` 返回纯文本 `ok`；`/info` 返回原始 JSON；MCP 端点使用 JSON-RPC 结构；Basic Auth 失败返回纯文本。除这些接口外，接口使用下方统一响应结构（`/ping` 也使用统一结构）。

成功响应：

```json
{
  "code": 200,
  "message": "success",
  "timestamp": 1730000000,
  "data": {}
}
```

`data` 只在有内容时出现，例如注册接口和批量推送接口。

失败响应：

```json
{
  "code": 400,
  "message": "device token is empty",
  "timestamp": 1730000000
}
```

出错时 HTTP 状态码与 `code` 一致（APNs 失败时见 [推送结果与错误](#推送结果与错误)）。Basic Auth 失败是例外，返回纯文本。

## 认证

启用 `BASIC_AUTH` 后，除白名单路径外的所有接口都需要 HTTP Basic Auth。

- `BASIC_AUTH` 是**单个** `用户名:密码` 字符串，在构建时注入。
- 请求头格式：

  ```http
  Authorization: Basic base64("用户名:密码")
  ```

  例如 `BASIC_AUTH=user:password` 时，请求头为 `Authorization: Basic dXNlcjpwYXNzd29yZA==`。使用 curl 时可直接写 `-u user:password`。

- 未设置 `BASIC_AUTH`（空字符串）时不启用认证。
- 认证失败返回 HTTP `401`，响应体为纯文本 `Unauthorized`，并带有 `WWW-Authenticate: Basic`。
- 白名单路径（均相对于 `URL_PREFIX`）：
  - `/`
  - `/ping`
  - `/register` 及其子路径（包括 `GET /register/:device_key`）
  - `/healthz`

> **Worker 差异**：上游 bark-server 使用独立的用户名、密码配置；本 worker 使用单个 `BASIC_AUTH=user:password`。另外，本 worker 的根路径 `/` 也在白名单内。
>
> 本服务**不支持**通过查询参数传递认证信息（例如 `?user=...&password=...`），客户端必须能发送 `Authorization` 请求头。

## 注册设备

### POST /register

支持的 `Content-Type`：

- `application/json`（或 `application/*+json`）
- `application/x-www-form-urlencoded`
- `multipart/form-data`

其他类型返回 HTTP 400：`request bind failed2: Unprocessable Entity`。

请求参数：

| 参数 | 别名 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `device_token` | `devicetoken` | string | 是 | 设备的 APNs token，最长 160 字符 |
| `device_key` | `key` | string | 否 | 已有设备 key；存在时复用该 key，不存在时由服务端重新生成 |
| `device_type` | `devicetype` | string | 否 | `ios` 或 `watchos`（不区分大小写），默认 `ios` |

规则：

- `device_token` 为空或缺失：HTTP 400，`device token is empty`。
- `device_token` 超过 160 字符：HTTP 400，`device token is invalid`。
- `device_type` 不是 `ios` / `watchos`：HTTP 400，`invalid device type: ...`。
- 传入的 `device_key` 必须已经存在才会被复用；否则服务端生成新的 key。服务端生成的 key 为 22 位字母数字字符串。
- `ALLOW_NEW_DEVICE=false` 时禁止注册新 key；用已有 key 重新注册仍然可用。此时若需要生成新 key，返回 HTTP 500：`device registration failed: register disabled`。
- `device_token=deleted` 表示注销设备，服务端会删除该 `device_key` 对应的记录（见下文）。

响应中的 `data`：

```json
{
  "code": 200,
  "message": "success",
  "timestamp": 1730000000,
  "data": {
    "key": "xxxxxxxxxxxxxxxxxxxxxx",
    "device_key": "xxxxxxxxxxxxxxxxxxxxxx",
    "device_token": "abcdef012345",
    "device_type": "ios"
  }
}
```

`key` 与 `device_key` 相同，`key` 用于兼容旧客户端。

> **Worker 差异**：`device_token=deleted` 是 worker 特有行为，用于注销设备。通常应提供已存在的 `device_key`：key 存在时会删除对应记录；key 不存在时仍会先走新设备注册流程（允许新设备时生成一个临时 key 再删除，不允许时返回 500）。删除后响应中的 `device_token` 为 `deleted`。
>
> KV 写入存在延迟，注册后通常需要等待几秒才能开始推送。

### GET /register（V1 兼容）

旧版客户端通过查询参数注册：

```sh
curl "<base>/register?device_token=abcdef012345&device_key=optional-key&device_type=ios"
```

支持的参数及别名与 `POST /register` 相同（`device_token` / `devicetoken`、`device_key` / `key`、`device_type` / `devicetype`），校验规则也相同。

### GET /register/:device_key

检查设备是否已注册：

- 设备存在且 token 有效：HTTP 200，返回统一成功响应，无 `data`。
- 设备不存在或保存的 token 为空：HTTP 400，`message` 中包含 `device token` 相关信息。

该接口位于 Basic Auth 白名单内，启用认证时也可以匿名访问。

## 推送

### POST /push

这是 V2 推送接口。行为取决于 `Content-Type`：

| Content-Type | 参数来源与优先级 | 是否解析 `device_keys` |
| --- | --- | --- |
| JSON | body 与 query，同名参数 **query 优先** | 是 |
| 表单 / multipart / 无 body | query 与表单 body，同名参数 **body 优先** | 否 |

JSON 请求体必须是单个对象。数组、`null` 或非法 JSON 会返回 HTTP 400，`message` 为 `request bind failed: ...`（其中数组和 `null` 为 `request bind failed: invalid JSON body`）。表单 body 解析失败时按空 body 处理。

单设备推送要求提供 `device_key`：

- 缺失或为空：HTTP 400，`device key is empty`。
- 设备不存在：HTTP 400，`failed to get device token: failed to get [<key>] device token from database`。
- 设备记录存在但 token 为空（例如 APNs 返回 410 后）：HTTP 400，`device token invalid`。

成功时返回统一成功响应，无 `data`：

```json
{"code": 200, "message": "success", "timestamp": 1730000000}
```

也可以只通过 query string 推送（即使没有请求体）：

```sh
curl -X POST "<base>/push?device_key=<key>&body=hello&sound=alarm"
```

### V1 兼容路由

以下路由同时支持 `GET` 和 `POST`：

| 路径 | 路径参数 |
| --- | --- |
| `/:device_key` | `device_key` |
| `/:device_key/:body` | `device_key`、`body` |
| `/:device_key/:title/:body` | `device_key`、`title`、`body` |
| `/:device_key/:title/:subtitle/:body` | `device_key`、`title`、`subtitle`、`body` |

参数优先级：

- `GET`：URL path > query string。
- `POST` + JSON body：URL path > query string > JSON body。
- `POST` + 表单：URL path > 表单 body > query string。

路径参数会进行 URL 解码，`+` 会被当作空格。路径参数解码失败时返回 HTTP 400：`url path parse failed`。

示例：

```sh
curl "<base>/<device_key>/Hello/World?sound=alarm&group=test"
```

等价于 `title=Hello`、`body=World`、`sound=alarm`、`group=test`。

V1 路由的响应与 `POST /push` 相同。

### 批量推送

批量推送属于 V2 语义，仅在请求以 JSON 发送时解析（`POST /push`；V1 POST 路由发送 JSON body 时也复用同一套解析逻辑）。GET 和表单请求中的 `device_keys` 不会触发批量逻辑。

- `device_keys` 可以是字符串数组，也可以是逗号分隔的字符串。
- 逗号分隔字符串按原样 `split`，**不会自动去除空格**；返回结果中的 `device_key` 也是原始片段。
- 数组元素会逐个转换为字符串。
- 其他类型（例如数字）返回 HTTP 400：`invalid type for device_keys`。
- 批量列表非空时优先执行批量推送，并忽略单设备参数 `device_key`；空数组等同于普通单设备推送。
- 每个设备独立推送，单个设备失败不会导致整个请求失败。顶层 HTTP 状态仍为 200，`data` 为每个设备的处理结果：
  - `code`：该设备的处理结果，APNs 失败时为 APNs 的真实状态码。
  - `device_key`：该设备 key。
  - `message`：失败时出现。

请求示例：

```json
{
  "device_keys": ["key1", "key2"],
  "body": "批量推送",
  "group": "test"
}
```

响应示例：

```json
{
  "code": 200,
  "message": "success",
  "timestamp": 1730000000,
  "data": [
    {"code": 200, "device_key": "key1"},
    {"code": 410, "device_key": "key2", "message": "push failed: Unregistered"}
  ]
}
```

批量上限由 `MAX_BATCH_PUSH_COUNT` 控制：

- 未设置或为 `-1`：不限制。
- 设置为非负整数：批量数量超过该值时，整个请求返回 HTTP 400：`batch push count exceeds the maximum limit: <n>`。

> ESA 平台本身对单次请求的并发/耗时也有限制，实际可用的批量规模可能小于配置值。

### 推送参数

下表中的类型是推荐类型；服务端对大多数参数不做严格校验。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `device_key` | string | 单设备推送的目标 key，不会写入 APNs payload |
| `device_keys` | string[] \| string | 批量推送设备列表，仅 JSON 请求生效 |
| `title` | string | 通知标题 |
| `subtitle` | string | 通知副标题 |
| `body` | string | 通知正文；`title`、`subtitle`、`body` 都为空时，APNs alert 的 body 为 `Empty Message` |
| `sound` | string | 通知铃声。未提供时 `aps.sound` 为 `1107`；提供的字符串值若不以 `.caf` 结尾会自动补全后缀（例如 `minuet` -> `minuet.caf`） |
| `group` | string | 通知分组，同时写入 `thread-id` 和扩展字段 `group` |
| `call` | string | 值为 `1` 时客户端循环响铃 30 秒；服务端只透传，建议传字符串 `"1"` |
| `isArchive` / `isarchive` | string | 值为 `1` 时客户端归档通知，其他值不归档；服务端只透传 |
| `icon` | string | 通知图标 URL，仅 iOS 15 及以上支持 |
| `image` | string | 通知图片 URL |
| `ciphertext` | string | 加密推送的密文，原样透传，由客户端解密 |
| `iv` | string | 加密推送使用的 IV，原样透传 |
| `level` | string | `critical`、`active`、`timeSensitive`、`passive`；服务端不校验 |
| `volume` | number | critical 通知的音量，通常为 0–10；服务端不校验 |
| `badge` | number | App 图标角标数字 |
| `url` | string | 点击通知后跳转的 URL |
| `action` | string | 设为 `none` 时点击通知不执行动作 |
| `copy` | string | 点击复制时复制的文本 |
| `autoCopy` / `autocopy` | string | 值为 `1` 时自动复制 `copy` 的文本；透传时键名为 `autocopy` |
| `id` | string | 通知折叠 ID，同时作为 `apns-collapse-id` 请求头和 payload 字段 `id` |
| `delete` | boolean \| number \| string | 静默推送；接受 `true`、`1`、`"1"`、`1.0`、`"1.0"`、`"true"` |
| `markdown` | string | Markdown 正文；服务端原样透传，**不会**转换成 `body`，由客户端处理 |
| `ttl` | number \| string | 归档消息的保留秒数；仅作为 payload 扩展字段透传（见下文） |
| `ext_params` | object | 扩展参数对象，会被展开为 payload 顶层字段 |

#### 透传规则

除 `title`、`subtitle`、`body`、`sound` 这些特殊字段外，其余参数都会写入 APNs payload 的顶层（与 `aps` 同级），并遵循以下规则：

- 键名统一转为小写，值统一转换为字符串。例如 `ttl: 60` 会变成 `"ttl": "60"`，`isArchive: "1"` 会变成 `"isarchive": "1"`。
- 对象值（包括 `ext_params`，也包括任意其他对象值参数）会被展开为多个顶层字段，嵌套键同样转为小写。
- 数组不会被展开，会整体转换为字符串（例如 `["a","b"]` 变成 `"a,b"`）。
- 顶层参数值为 `null` / `undefined` 时会被忽略（嵌套对象中的 `null` 会被转成字符串 `"null"`）。
- `device_key` 和 `ext_params` 本身不会出现在 payload 中。
- 未在文档中列出的自定义参数同样会透传。例如 `{"foo": "bar"}` 会变成 payload 中的 `"foo": "bar"`。

服务端不校验 `level`、`volume` 等取值；例如 MCP 工具 schema 中 `volume` 的默认值和范围仅供参考。

#### APNs payload 固定行为

- 普通通知：
  - `aps.alert.title` / `aps.alert.subtitle` / `aps.alert.body` 来自对应参数。
  - `aps.sound`：未提供 `sound` 时为 `1107`（不会补 `.caf`）；提供字符串值时自动补 `.caf` 后缀。
  - `aps.thread-id` 来自 `group`。
  - `aps.category` 固定为 `myNotificationCategory`，`aps.mutable-content` 为 `1`。
- 静默推送（`delete`）：`aps` 只包含 `content-available: 1` 和 `mutable-content: 1`，`apns-push-type` 为 `background`，不发送 alert 和 sound；其他透传参数仍会出现在 payload 顶层。
- `apns-topic` 根据注册时的 `device_type` 选择：`ios` 使用 `me.fin.bark`，`watchos` 使用 `me.fin.bark.watch`。
- `apns-expiration` 固定为当前时间 + 24 小时。`ttl` 不会修改该值，它只是透传给客户端用于归档消息的过期处理。

### 推送结果与错误

- 推送成功：HTTP 200，统一成功响应。
- 设备不存在或 token 为空：HTTP 400。
- APNs 返回非 200：HTTP 状态码为 **APNs 的真实状态码**，响应体为统一错误结构，`message` 形如 `push failed: <APNs reason>`。
  - `410` 或 `400 BadDeviceToken`：服务端会清空该设备保存的 token（保留 key）。之后需要重新注册（可使用同一 `device_key`）才能继续推送。
  - `403 ExpiredProviderToken`：服务端会重新生成 APNs 认证 token 并自动重试一次。
- APNs 网络错误等异常：HTTP 500。

> **Worker 差异**：上游 bark-server 的推送实现在 APNs 失败时固定返回 500；本 worker 返回 APNs 的真实状态码（例如 410），便于调用方区分 `Unregistered`、`BadDeviceToken` 等情况。

## 其他接口

| 接口 | 方法 | 响应 |
| --- | --- | --- |
| `/` | 所有方法 | 纯文本 `ok` |
| `/ping` | 所有方法 | 统一 JSON，`message` 为 `pong` |
| `/healthz` | 所有方法 | 纯文本 `ok` |
| `/info` | 所有方法 | 原始 JSON（不使用统一响应结构） |

`/info` 示例：

```json
{
  "version": "v2.4.0",
  "build": "2026-11-26 12:34:56",
  "arch": "js/esa",
  "commit": "git-commit-id",
  "time": 1730000000000,
  "devices": 42
}
```

| 字段 | 说明 |
| --- | --- |
| `version` | 构建时注入的版本号，形如 `v2.4.0` |
| `build` | 构建时间（UTC，`YYYY-MM-DD HH:mm:ss`） |
| `arch` | 固定为 `js/esa` |
| `commit` | 构建时的 git commit；无法获取时为空字符串 |
| `time` | 当前时间，毫秒时间戳 |
| `devices` | 设备数量；`ALLOW_QUERY_NUMS=false` 时该字段省略 |

> 设备数量基于 KV 计数器，可能不准确，仅供粗略参考。

## 错误码

| HTTP 状态码 | 场景 |
| --- | --- |
| 200 | 成功；批量推送中单个设备失败时顶层仍为 200 |
| 400 | 参数校验失败、设备不存在、批量数量超限、APNs 返回 `BadDeviceToken` 等 |
| 401 | Basic Auth 失败（纯文本 `Unauthorized`） |
| 403 | APNs 认证相关错误（真实状态码透传） |
| 404 | 未匹配到任何路由（Hono 默认纯文本 404） |
| 410 | APNs 返回 `Unregistered`（真实状态码透传） |
| 500 | 未预期异常、APNs 网络错误、注册被禁用等 |

## 配置项（与 API 相关）

以下配置在构建时注入，详见 [README](../README.md)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `URL_PREFIX` | `/` | 部署路径前缀 |
| `BASIC_AUTH` | 空 | `用户名:密码`；为空时不启用认证 |
| `ALLOW_NEW_DEVICE` | `true` | 设为 `false` 时禁止注册新的设备 key |
| `ALLOW_QUERY_NUMS` | `true` | 设为 `false` 时 `/info` 不返回 `devices` |
| `MAX_BATCH_PUSH_COUNT` | 不限制 | 批量推送最大数量；`-1` 也表示不限制 |
| `DB_NAME` | `bark` | KV 数据库名称 |
| `APNS_URL` | `api.push.apple.com` | 自定义 APNs 主机名 |

## Worker 特有行为

| 项目 | 本 worker 的行为 |
| --- | --- |
| Basic Auth 配置 | 单个 `BASIC_AUTH=user:password`，失败返回 401 + `WWW-Authenticate: Basic` |
| 新设备注册开关 | 支持 `ALLOW_NEW_DEVICE` |
| 设备数量开关 | 支持 `ALLOW_QUERY_NUMS` |
| 注销设备 | `device_token=deleted` 删除设备记录 |
| 推送失败状态码 | 透传 APNs 的真实状态码，而不是固定 500 |
| `/info` | `arch` 为 `js/esa`，额外返回毫秒时间戳 `time` |
| 批量上限 | `MAX_BATCH_PUSH_COUNT`，默认不限制 |
| 存储 | Aliyun EdgeKV，注册后可能有数秒写入延迟，设备计数可能不准确 |

## curl 示例

以下示例使用 `BASE` 表示服务地址，`KEY` 表示设备 key：

```sh
BASE="https://bark.example.com/bark"
KEY="xxxxxxxxxxxxxxxxxxxxxx"
```

注册设备（启用 Basic Auth 时加上 `-u user:password`）：

```sh
curl -X POST "$BASE/register" \
  -H "Content-Type: application/json" \
  -d '{"device_token":"abcdef012345","device_type":"ios"}'
```

单设备推送：

```sh
curl -X POST "$BASE/push" \
  -H "Content-Type: application/json" \
  -d "{
    \"device_key\": \"$KEY\",
    \"title\": \"构建完成\",
    \"body\": \"bark-worker-server 已部署\",
    \"sound\": \"minuet\",
    \"group\": \"CI\",
    \"level\": \"active\",
    \"badge\": 1,
    \"url\": \"https://example.com\"
  }"
```

批量推送：

```sh
curl -X POST "$BASE/push" \
  -H "Content-Type: application/json" \
  -d '{"device_keys":["key1","key2"],"body":"批量推送"}'
```

V1 兼容推送：

```sh
curl "$BASE/$KEY/Hello/World?sound=alarm&group=test"
```

检查设备注册状态：

```sh
curl "$BASE/register/$KEY"
```

健康检查与信息：

```sh
curl "$BASE/ping"
curl "$BASE/healthz"
curl "$BASE/info"
```
