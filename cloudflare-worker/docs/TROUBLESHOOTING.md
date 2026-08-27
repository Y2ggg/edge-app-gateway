# 故障排查

先访问当前自定义域名：

```text
https://项目域名/_edge-gateway/health
```

在统一入口域名上预期 build 为 `2026-08-27-gateway-v9`。不符时先确认最新 Dashboard 包或 Wrangler Deployment 已进入 Production，Custom Domain 绑定到同一 Worker。受统一入口限制的 Demo 会将健康接口隐匿为 404，不应在这些域名上读取 build。

## Gateway 配置错误

`EDGE_CONFIGURATION_ERROR` 表示 Worker 在发起上游请求前拒绝了不安全配置。检查：

- `ROUTE_PROJECTS_JSON` 是否使用新协议，是否仍残留旧顶层 `passwordHash`/`rewriteOrigins`。
- `edgeAccess=required` 是否有 passwordHash 和有效的 `ROUTE_SESSION_SECRET`。
- `originProtection=required` 的 `secretBinding` 是否与 Cloudflare Secret Binding 名完全一致，值是否至少 16 个字符。
- 上游按 Host 校验 Origin 时，是否设置 `requestOriginPolicy: rewrite-to-upstream`。
- redirect 是否错误搭配 required 源站保护或写方法。
- 多应用的 `ROUTE_BASE_DOMAIN`、Custom Domain 前缀和 alias 是否一致。
- `entryAccess=required` 的入口 Alias 是否存在，入口与目标是否都为 proxy，入口是否启用了 Edge Access 且没有依赖另一入口。

日志只应出现错误类别，不能打印 JSON、Binding 名、密码、Hash、Session 或 Secret 值。

## 登录问题

| 现象 | 检查 |
| --- | --- |
| 登录 POST 总是失败 | Origin 必须等于当前 HTTPS Origin；缺少 Origin 时 Referer 必须同源 |
| 正确密码仍失败 | 散列和线上验证必须使用同一个 `ROUTE_SESSION_SECRET` |
| 429 | 同一 IP+alias 失败次数过多，等待 Retry-After；同时检查 Rate Limiter 配置 |
| 登录后仍返回 401 | 浏览器是否接受 `Secure; HttpOnly; SameSite=Lax; Path=/` 的 `route_session`，Host 是否变化 |
| 上游看到了 `route_session` 或 `entry_session` | 确认运行最新 build，并检查是否是上游自己设置了同名 Cookie |

未知 alias、错误密码和安全校验失败对浏览器显示相同消息，日志也不会输出具体原因。

## 上游应用认证和 Cookie

上游 401/403 现在是正常业务响应，不代表 Gateway 故障。若页面显示上游 Access Gate，说明 `edgeAccess=disabled` 或 Gateway 验证后已经正常进入上游。

上游登录/退出返回 `ORIGIN_NOT_ALLOWED` 时，检查路由是否启用了 `rewrite-to-upstream`，并在上游日志中确认收到的 Origin 是 Vercel target Origin、Referer 路径仍完整、`X-Forwarded-Host` 是用户自定义 Host。Gateway 返回 `EDGE_ORIGIN_NOT_ALLOWED` 则表示客户端发送了跨站、opaque 或格式异常的 Origin；这是边缘安全拒绝，不能通过放宽为“全部重写”绕过。

应用登录循环时检查 Network：

- 请求 Cookie 中应用 Session 是否存在；Gateway 只应删除 `route_session` 和 `entry_session`。
- 上游是否返回多个 Set-Cookie，是否都到达浏览器。
- 上游显式 `Domain=*.vercel.app` 时，按需将 `cookieDomainPolicy` 设为 `strip` 或 `rewrite`。
- 同上游 Location 应改写为当前自定义域名；跳往外部身份提供商的 Location 会保留。

## 统一入口问题

| 现象 | 检查 |
| --- | --- |
| 直接访问 Demo 显示“页面无法打开”404 | `entryAccess=required` 的预期行为，应从已登录的统一入口 Card 进入 |
| 从入口点击也返回“页面无法打开”404 | 入口是否持有当前 Host 的 `route_session`；Card 是否使用同源相对 GET launch；浏览器是否发送 `same-origin`/`navigate`/`document`/`Sec-Fetch-User: ?1` |
| launch 或 entry 返回 503 | `ROUTE_SESSION_SECRET` 和 `ROUTE_BASE_DOMAIN` 是否有效；`ENTRY_TICKET_REDEEMER` Durable Object Binding 与 migration 是否随最新 `wrangler.jsonc` 部署 |
| 目标验票返回 404 | ticket 是否已超过 30 秒、已兑换过、目标路径是否被改变，或入口与目标是否来自同一份最新路由配置 |
| 进入后一段时间又返回 404 | `entry_session` 已过期；返回统一入口重新点击，或检查目标 `entryAccess.ttlSeconds` |
| 伪造 Referer 仍返回 404 | 正常；Referer 不参与授权，只有签名票据和 Host-only Session 有效 |
| Vercel Production URL 仍能直连 | 检查 Vercel WAF Origin Secret 规则；这不是 `entryAccess` 能覆盖的流量 |

入口 Cookie 与目标 Cookie 都是 Host-only，不能期望浏览器把入口的 `route_session` 直接发送给 Demo。跨 Host 授权必须经过 launch → entry 的 303 跳转链。Gateway Cookie 不会转发给上游应用。

## POST、API 和流式问题

405 时查看响应 `Allow`，并确认路由 `allowedMethods` 和 `proxyProfile`。fullstack 才能允许写方法；static 仅允许 GET、HEAD、OPTIONS。

API 上游连接失败应返回 502 JSON `EDGE_UPSTREAM_UNAVAILABLE`。上游已经返回的 400/401/403/404/409/422/429/500/502/504 必须保留原正文；若变成 HTML，确认请求是否误打到旧 Worker。

NDJSON/SSE 延迟时检查：

- 上游是否在每块后主动 flush，而不是应用框架自身缓冲。
- Content-Type 是否是 `application/x-ndjson`、`application/ndjson`、`application/json-seq` 或 `text/event-stream`。
- 中间 CDN、浏览器客户端或命令行工具是否缓冲输出；curl 可使用 `--no-buffer`。
- 响应 `Cache-Control` 应为 `no-store`。

## 源站 WAF 问题

通过自定义域名也被 Vercel 拒绝时，先把 WAF 保持在 Log，核对该项目 Header 名、Worker `secretBinding` 和 Vercel 规则值。不要在 curl、日志或工单中输出正确 Secret。

直连 Vercel 仍成功时，分别测试 Header 缺失和错误值。如果缺失 Header 没有命中 `Does not equal`，使用“正确 Header Allow/Bypass + 其他全部 Deny”两条规则。静态资源和 API 必须与页面同样被拒绝。

## 缓存问题

只有无 Authorization、无应用 Cookie、无 Set-Cookie 的 200 静态资源会在 `assets-only` 下保留或获得公共缓存。HTML、`/api`、写方法、NDJSON/SSE 和应用会话请求均应 `no-store`。发现用户数据被缓存时立即将该路由改为 `cachePolicy: no-store`，清除 Cloudflare/Vercel 缓存后再定位 Content-Type、路径和 Cookie。

## 本地维护

```bash
npm run repository:check
npm run dashboard:build
npm test
npm run test:coverage
npm run deploy:check
```

以上维护和验证命令均在本地手动执行，不会由 push、pull request 或 tag 触发。不要直接修改 `dashboard/worker.js`；修复模块源码、测试后重新生成。
