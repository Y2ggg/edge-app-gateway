# 配置与安全

## 环境变量和 Binding

| 名称 | 必需 | 约束 |
| --- | --- | --- |
| `ROUTE_PROJECTS_JSON` | 是 | 1–200 个应用组成的新协议 JSON 映射，生产环境建议存为 Secret |
| `ROUTE_BASE_DOMAIN` | 多应用必需 | 仅域名，例如 `apps.example.com`，不含协议、端口、路径或通配符 |
| `ROUTE_SESSION_SECRET` | Edge Access required 时必需 | 至少 32 个字符，用于密码 HMAC 和 alias 绑定的 Session 签名 |
| `ROUTE_SESSION_TTL_SECONDS` | 否 | 300–604800，默认 28800 秒 |
| 路由中的 `secretBinding` | Origin Protection required 时必需 | Binding 名进入 JSON，Secret 值单独保存在 Cloudflare |
| `EDGE_LOGIN_RATE_LIMITER` | 建议 | Wrangler 已配置为每 IP+alias 每分钟最多 5 次登录提交；另有 isolate 内失败计数兜底 |

一个上游一个 Secret，不复用：例如 `ORIGIN_SECRET_PROJECT_A`、`ORIGIN_SECRET_PROJECT_B`。Secret 值不能进入 JSON、日志、响应、Git 或截图。

## 路由协议

```json
{
  "data-app": {
    "target": "https://data-app.vercel.app",
    "deliveryMode": "proxy",
    "proxyProfile": "fullstack",
    "requestOriginPolicy": "rewrite-to-upstream",
    "edgeAccess": {
      "mode": "disabled"
    },
    "originProtection": {
      "mode": "required",
      "headerName": "x-edge-app-gateway-origin",
      "secretBinding": "ORIGIN_SECRET_DATA_APP"
    },
    "allowedMethods": [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS"
    ],
    "cachePolicy": "assets-only",
    "cookieDomainPolicy": "strip"
  }
}
```

字段规则：

- Alias 为 3–63 位小写字母、数字或短横线。多应用时，`alias.apps.example.com` 的 alias 必须存在于映射中。
- `target` 必须是无凭据、查询和片段的 `https://*.vercel.app` URL，可包含固定基础路径。
- `deliveryMode` 为 `proxy` 或显式 `redirect`。Edge Access disabled 不会自动改变该字段。
- `proxyProfile` 为 `static` 或 `fullstack`。static 只能允许 GET、HEAD、OPTIONS；fullstack 可使用全部受支持方法。
- `requestOriginPolicy` 可省略，默认 `preserve`。`rewrite-to-upstream` 只改写原本与用户自定义域名同源的 Origin/Referer，适用于按 Vercel Host 校验同源的上游 Access Gate。redirect 模式不能使用改写策略。
- `edgeAccess.mode` 为 `disabled` 或 `required`。required 必须有 `edgeAccess.passwordHash`；disabled 时该字段不读取，也不需要 `ROUTE_SESSION_SECRET`。
- `originProtection.mode` 为 `disabled` 或 `required`。required 必须有安全的自定义 `x-` Header 名和大写 Binding 名 `secretBinding`；`x-vercel-protection-bypass` 被明确禁止。
- `deliveryMode=redirect` 不能与 required 源站保护共存，而且只能允许 GET/HEAD。
- `allowedMethods` 必须是非空、无重复的受支持方法数组。Worker 规范化 `Allow` 顺序。
- `cachePolicy` 可省略，默认 `no-store`；可选 `assets-only`。
- `cookieDomainPolicy` 可省略，默认 `strip`；`strip` 删除上游 Cookie 的显式 Domain，`rewrite` 将它改为当前自定义主机。Host-only Cookie 不修改。

旧的顶层 `passwordHash`/`rewriteOrigins` 配置不会被兼容，必须一次性迁移。Gateway 不修改响应正文，也不修改压缩后的 JavaScript。

## Edge Access

专属接口位于：

- `GET|POST /_edge-gateway/login`
- `POST /_edge-gateway/logout`
- `GET /_edge-gateway/session`
- `GET /_edge-gateway/health`

登录 POST 必须提供同源 `Origin`，或在 Origin 缺失时提供同源 `Referer`。失败、未知 alias 和错误密码使用相同页面和日志消息。失败尝试按客户端 IP+alias 限制；生产部署同时使用 `EDGE_LOGIN_RATE_LIMITER` Binding，内存计数仅作为补充。

`route_session` 为无 Domain 的 Host-only Cookie，设置 `Path=/; HttpOnly; Secure; SameSite=Lax`。alias 写入签名 Token，因此其他 alias 的 Token 无效。当前路由按独立主机承载 alias，`Path=/` 正是该 alias 主机可用的最窄业务路径。转发前只删除这个 Gateway Cookie，其他 Cookie 保留。

使用当前会话密钥生成密码散列：

```bash
npm run password:hash -- "访问密码" "ROUTE_SESSION_SECRET"
```

更换 `ROUTE_SESSION_SECRET` 会使所有现有 Session 和密码散列失效；required 路由需要重新生成散列。

## 请求与响应代理

请求复制全部端到端 Header，明确删除 `Connection` 指定项和 keep-alive、TE、Trailer、Transfer-Encoding、Upgrade 等 hop-by-hop Header。客户端提供的 Forwarded 信息会被可信入口信息覆盖；客户端提供的源站保护 Header 会先删除，再由 Worker 从路由指定 Binding 写入。GET/HEAD 不设置正文，其他允许方法直接传递 `request.body`。

当 `requestOriginPolicy=rewrite-to-upstream` 时：

- 浏览器 `Origin` 精确等于当前自定义 Origin 时，改写为配置目标的上游 Origin。
- Referer 与当前自定义 Origin 同源时，只替换 Origin 部分，保留路径、查询和片段。
- `Origin: null`、格式异常或跨站 Origin 返回 403 `EDGE_ORIGIN_NOT_ALLOWED`，请求不会到达上游。
- 没有 Origin 的服务端/API 请求不补造 Origin，继续代理。
- 只有跨站 Referer而没有 Origin 的普通外部导航不会被阻断，Referer 保持原样。
- `X-Forwarded-Host` 始终由 Gateway 写成用户实际访问的 Host，不会随 Origin 改写。

响应复制端到端 Header 和全部 Set-Cookie，重写同一上游 Origin 的 Location，并直接用 `upstreamResponse.body` 构造下游 Response。Worker 不调用业务响应的 `text()`、`json()` 或 `arrayBuffer()`。

## 缓存规则

`no-store` 对所有响应强制禁用缓存。`assets-only` 仅在同时满足以下条件时允许缓存：GET/HEAD、200、已识别静态扩展名和静态 Content-Type、无 Authorization、无应用 Cookie、无 Set-Cookie、非 `/api`、非 NDJSON/SSE。上游有 Cache-Control 时保留；没有时使用 `public, max-age=3600`。其他响应强制 `no-store`。

## Gateway 错误协议

```json
{
  "error": {
    "code": "EDGE_UPSTREAM_UNAVAILABLE",
    "message": "上游服务暂时不可用"
  }
}
```

上游已返回的 4xx/5xx 不是 Gateway 错误，状态、类型、Header 和正文原样传递。只有 fetch 无法连接上游，且请求同时是 GET/HEAD、接受 HTML、`Sec-Fetch-Mode: navigate`、`Sec-Fetch-Dest: document` 时，才返回 HTML 不可用页面。
