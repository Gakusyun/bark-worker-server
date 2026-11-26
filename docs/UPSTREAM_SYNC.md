# 上游同步说明

- 上游基线：[Finb/bark-server](https://github.com/Finb/bark-server) `v2.4.0`（commit `a365aa9`，2026-11-06）
- 同步日期：2026-11-27
- 同步依据：`bark-worker-server-差距分析报告.md`（2026-11-26）

## 已同步

| 项目 | 说明 |
| --- | --- |
| Basic Auth 全站保护 | 除 `/`、`/ping`、`/register`（含子路径）、`/healthz` 外的接口均受保护 |
| watchOS 支持 | 注册接受 `device_type`（`ios` / `watchos`），设备记录保存类型，推送按类型选择 `me.fin.bark` / `me.fin.bark.watch` |
| 设备记录 | KV 值升级为 `{token, type, updated_at}` JSON，兼容旧裸 token 记录（视为 iOS） |
| MCP | 实现 `POST /mcp` 与 `POST /mcp/:device_key`，包含会话 ID、协议协商、`notify` 工具与上游一致的 schema/返回文本 |
| 注册检查 | 新增 `GET /register/:device_key` |
| token 长度 | 注册上限 160，移除推送时删除超长 token 的逻辑 |
| 参数透传 | 任意 query/body/path 参数进入 payload；`ttl`、自定义字段、`ext_params` 与对象值参数按上游规则展开/字符串化 |
| 批量推送 | `device_keys` 支持数组与逗号分隔字符串，仅 JSON 请求生效；响应 `data` 为扁平数组 |
| 失效 token | APNs 410 / `BadDeviceToken` 时清空 token 但保留设备 key，与上游一致 |
| `/info` | 构建时注入 `version` / `build` / `commit` |
| 缺陷修复 | APNs provider token 过期判断、重试路径引用旧响应、设备计数漂移、设备 key 读写清洗不一致 |
| 工程 | 路由/MCP 集成测试、GitHub Actions CI、API 与 MCP 文档 |

## 有意保留的差异

| 项目 | 本 worker 行为 | 原因 |
| --- | --- | --- |
| Basic Auth 失败响应 | `401` + `WWW-Authenticate: Basic` | 比上游的 `418 I'm a teapot` 更规范 |
| APNs 失败状态码 | 透传 APNs 真实状态码（如 410） | 便于调用方区分失败原因；上游固定 500 |
| 配置方式 | `BASIC_AUTH=用户名:密码` 单字符串 | 沿用既有 worker 配置方式 |
| 注册开关 | `ALLOW_NEW_DEVICE` / `ALLOW_QUERY_NUMS` | worker 既有能力，上游无对应开关 |
| 注销设备 | `device_token=deleted` 删除记录 | worker 便利特性 |
| MCP 会话 | 仅校验 `Mcp-Session-Id` 格式，不持久化会话 | edge worker 无进程内状态；与上游 stateless session manager 行为兼容 |
| `/info` | 额外返回毫秒时间戳 `time` | 延续 worker 既有字段 |
| 设备 key | 读写时清洗为字母数字 | 避免特殊字符导致 KV key 不可读 |
| V1/V2 方法 | `/ping`、`/healthz`、`/` 接受所有方法 | 与既有 worker 行为一致，无实际风险 |
