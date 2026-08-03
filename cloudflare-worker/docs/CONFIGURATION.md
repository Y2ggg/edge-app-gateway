# 配置与安全

## 环境变量

| 名称 | 必需 | 约束 |
| --- | --- | --- |
| `ROUTE_PROJECTS_JSON` | 是 | 1–200 个应用组成的 JSON 映射，建议保存为 Secret |
| `ROUTE_SESSION_SECRET` | 是 | 至少 32 个字符，建议使用工具生成并保存为 Secret |
| `ROUTE_BASE_DOMAIN` | 多应用必需 | 例如 `demo.example.com`，不含协议、路径或 `*` |
| `ROUTE_SESSION_TTL_SECONDS` | 否 | `300`–`604800`，默认 `28800` 秒 |

`ROUTE_PROJECTS_JSON` 是为现有部署兼容而保留的配置键名；本文将其中每个条目统一称为“应用”。

单应用且未配置 `ROUTE_BASE_DOMAIN` 时，Worker 自动选择唯一应用。多应用模式下，请求主机名去掉基础域后必须得到一个合法 alias：`portal.demo.example.com` → `portal`。

## 应用映射表

```json
{
  "portal": {
    "target": "https://portal-app.vercel.app",
    "passwordHash": "hmac-sha256$...",
    "rewriteOrigins": false
  }
}
```

- Alias 长度为 3–63，只能包含小写字母、数字和短横线。
- `target` 必须是公开的 `https://*.vercel.app`，可以包含固定基础路径，但不能包含凭据、查询参数或 `#`。
- `passwordHash` 必须由应用明文密码和当前 `ROUTE_SESSION_SECRET` 共同生成。
- `rewriteOrigins` 默认 `false`。建议保持该值，让响应正文按上游原样传输。

仅当旧应用在 HTML、CSS、JSON、XML 或 SVG 中硬编码了上游 Origin，且无法修改应用源码时，才考虑设置 `rewriteOrigins: true`。Worker 仍不会修改可执行 JavaScript。优先让前端使用相对 URL 或 `window.location.origin`。

## 密码和密钥

Worker 使用随机盐和 `ROUTE_SESSION_SECRET` 对应用密码计算 HMAC-SHA256。应用映射单独泄露时，攻击者无法在没有服务端密钥的情况下验证密码猜测。HMAC 不提供 PBKDF2 一类的慢速拉伸，因此应用密码仍应使用足够长的随机值。

同一个会话密钥还用于签名会话 Token，但两类消息使用不同格式。Cookie 与应用 alias 绑定，并设置：

```text
HttpOnly; Secure; SameSite=Lax; Path=/
```

轮换 `ROUTE_SESSION_SECRET` 会立即使所有会话和现有应用散列失效。正确顺序是：为全部应用生成新散列，原子更新完整应用映射与密钥，然后部署新 Production 版本。

## 敏感信息处理

- 不提交 `.dev.vars`、真实应用映射、密码、散列或会话密钥。
- 不在日志、问题单或聊天中粘贴 Secret 值。
- Dashboard Secret 不可回读，应在受控的密码管理工具中保留完整配置副本。
- 上游地址仅来自服务端应用映射。当前适配器要求上游位于 `*.vercel.app`；若前端构建产物自身包含绝对上游地址，`rewriteOrigins: false` 无法隐藏它，应在前端项目中改为相对地址。
- 认证页面对密码错误、未知 alias、无效配置和上游失败统一显示“无法访问”，避免枚举应用。
