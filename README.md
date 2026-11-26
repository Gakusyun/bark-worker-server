# Bark Worker Server

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

Bark Worker Server 是一个 [Bark-Server](https://github.com/Finb/bark-server) 在阿里云 ESA 边缘函数上的实现。

[GitHub](https://github.com/sylingd/bark-worker-server) [国内镜像](https://gitee.com/sy/bark-worker-server)

## 安装使用

### 阿里云 ESA

[部署教程](https://github.com/sylingd/bark-worker-server/wiki/%E9%98%BF%E9%87%8C%E4%BA%91-ESA-%E9%83%A8%E7%BD%B2) [国内镜像](https://gitee.com/sy/bark-worker-server/wikis/%E9%98%BF%E9%87%8C%E4%BA%91-ESA-%E9%83%A8%E7%BD%B2)

## 功能

* 兼容 Bark API V1 / V2，包括批量推送、`device_keys`、`ttl` 与自定义参数透传
* 支持 iOS 与 watchOS 设备（注册时传入 `device_type=watchos`）
* 支持 MCP（`/mcp` 与 `/mcp/:device_key`，相对 `URL_PREFIX`）
* 可选 HTTP Basic Auth，启用后除 `/`、`/ping`、`/register`（含 `/register/:device_key`）、`/healthz` 外的接口均受保护
* 功能基线跟踪上游 [bark-server](https://github.com/Finb/bark-server) v2.4.0

## 文档

* [API 参考](./docs/API.md)：注册、V1 / V2 推送、批量推送、推送参数与错误码
* [MCP 文档](./docs/MCP.md)：端点、会话、`notify` 工具参数与客户端配置
* [上游同步说明](./docs/UPSTREAM_SYNC.md)：上游 v2.4.0 同步范围与有意保留的差异

## 本地构建

```bash
pnpm install
pnpm build
```

构建产物为 `dist/index.js`，ESA 部署配置见 [`esa.jsonc`](./esa.jsonc)。

## MCP

服务端实现了 MCP Streamable HTTP 端点，可供 Claude Desktop、Cherry Studio、n8n 等客户端使用。

* `POST /mcp`：需要在工具参数中提供 `device_key`
* `POST /mcp/:device_key`：设备 key 固定在 URL 中
* 提供 `notify` 工具，参数与 Bark 推送参数一致（`title`、`body`、`markdown`、`level`、`volume`、`badge`、`call`、`sound`、`icon`、`image`、`group`、`isArchive`、`ttl`、`url`、`copy` 等）
* 启用 `BASIC_AUTH` 时，MCP 请求同样需要携带 `Authorization: Basic ...` 头

完整说明见 [docs/MCP.md](./docs/MCP.md)。

## 已知问题

* 因平台限制，批量推送功能存在最大上限。
* 因 KV 写入延迟，设备注册后，过一小段时间（几秒钟）才能开始推送。
* 设备计数并不准确，仅供测试数据库使用，请勿依赖此数据。

## 配置项

以下配置项在构建时注入，需在部署平台的构建环境变量中设置。

* `DB_NAME` KV 数据库名称，默认为 `bark`
* `ALLOW_NEW_DEVICE` 是否允许新设备注册，默认为 `true`
* `ALLOW_QUERY_NUMS` 是否允许查询设备数量，默认为 `true`
* `MAX_BATCH_PUSH_COUNT` 批量推送最大数量，默认不限制
* `BASIC_AUTH` HTTP Basic Auth 凭证，格式为 `用户名:密码`，默认不启用。启用后除 `/`、`/ping`、`/register`（含 `/register/:device_key`）、`/healthz` 外的接口均需要认证
* `URL_PREFIX` 部署路径，默认为 `/`
  * 例如：当你填写部署路径为 `/bark` 时，在 Bark App 中填写的服务器地址为 `https://你的域名/bark`，注意开头必须要有“/”，末尾不要有“/”
* `APNS_URL` 自定义 APNs 服务地址

## 其他

部分代码修改自 [cwxiaos/bark-worker](https://github.com/cwxiaos/bark-worker)，遵循原许可协议，以 GPLv3 协议发布。
