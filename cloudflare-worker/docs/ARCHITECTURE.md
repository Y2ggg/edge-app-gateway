# 架构与能力边界

## 请求流程

```text
用户自定义域名
        ↓
Cloudflare Worker 按 Host 解析 alias
        ├─ entryAccess=required：验证入口与目标绑定的通行 Session
        ├─ edgeAccess=required：验证 alias 绑定的 Gateway Session
        └─ edgeAccess=disabled：跳过验证
        ↓
检查路由方法白名单与代理模式
        ↓
按 requestOriginPolicy 校验并按需改写可信 Origin/Referer
        ↓
删除 Gateway Cookie、hop-by-hop Header 和伪造的源站 Header
        ↓
从项目独立 Secret Binding 注入源站密钥
        ↓
流式 fetch 到 Vercel WAF → 上游应用 → 应用自己的 Access Gate
        ↓
状态、Header、Cookie 和响应流返回同一自定义域名
```

`entryAccess`、`edgeAccess`、`originProtection`、`proxyProfile` 和上游 Application Access 没有隐式耦合。特别是 `edgeAccess=disabled` 只跳过 Gateway 登录，不会跳过 required 统一入口通行、把浏览器重定向到 Vercel 或禁用源站密钥。

## 统一入口信任链

```text
已通过 Edge Access 的入口 Host
        ↓ 用户点击 GET /_edge-gateway/launch?target=<目标 Host>&next=<路径>
验证同源用户导航 Fetch Metadata、入口 route_session 和入口→目标关系
        ↓ 303，携带 30 秒随机、不透明 HMAC 票据
目标 Host /_edge-gateway/entry
        ↓ 验证票据用途、入口 Alias、目标 Alias、目标路径、签名和过期时间
ENTRY_TICKET_REDEEMER Durable Object 原子消费票据
        设置目标 Host-only entry_session
        ↓ 303 到目标业务路径
Demo 普通请求验证 entry_session；缺失或无效时返回无标识 404
```

入口和目标必须属于同一份路由配置。票据及通行 Session 都由 `ROUTE_SESSION_SECRET` 签名，但用途上下文不同，不能互换；票据同时绑定入口、目标和规范化路径。Token 对外只显示版本、过期时间、随机 nonce 和签名，不显示可解码的 Alias、路径或用途。系统不把 `Referer` 单独当作现代浏览器授权，也不向统一入口项目提供 Secret。每张 handoff ticket 映射到独立 Durable Object，首次成功兑换后即被原子标记，30 秒有效期内的后续重放也会被隐匿拒绝。

## Origin 转换边界

自定义域名代理到 Vercel 后，浏览器 Origin 与上游实际 Host 天然不同。对使用 Host 做同源校验的应用，路由设置 `requestOriginPolicy=rewrite-to-upstream`：Gateway 先证明请求 Origin 与当前自定义 Origin 相同，再将它改写为上游 Origin；同源 Referer 也只替换 Origin 部分。该策略不会把跨站或 opaque Origin 伪装成可信请求，跨站 Origin 会在 fetch 前返回 403。无 Origin 的服务端客户端保持无 Origin，`X-Forwarded-Host` 继续记录用户自定义 Host。

## 流式边界

Worker 不解析或重新序列化业务请求体；写方法的 `request.body` 直接交给上游 fetch。响应同样直接使用 `upstreamResponse.body` 构建新 Response，因此 NDJSON/SSE 的首块可在上游结束之前到达客户端。Header 与 Cookie 的调整不会消费正文流。

流式类型由 Content-Type 通用识别，不包含任何项目域名或 SmartData 路径。`application/x-ndjson`、`application/ndjson`、`application/json-seq` 和 `text/event-stream` 强制 `no-store`。

## 认证和 Cookie 边界

Gateway Session 只证明访问者通过该 alias 的边缘验证。上游应用 Session 仍通过普通 Cookie/Authorization 工作：

- 请求中删除名为 `route_session` 和 `entry_session` 的 Gateway Cookie。
- 上游 Cookie 与 Authorization 保留。
- 上游多个 Set-Cookie 全部保留。
- 显式 Vercel Domain 按 `cookieDomainPolicy` 删除或重写；Host-only Cookie 原样传递。
- 上游 Access Gate 的 401、登录页面和跳转不会被 Gateway 转换成不可用页面。

## 错误边界

| 情况 | 行为 |
| --- | --- |
| 路由方法未允许 | Gateway 405 JSON，并带准确 `Allow` |
| Edge Access required 且无会话 | 文档导航进入 Gateway 登录；API 返回 Gateway 401 JSON |
| Entry Access required 且无有效通行 | 中性页面或空正文 404，不发起上游请求 |
| 入口签票目标无效、入口未认证或票据无效 | 与直访相同的隐匿 404 |
| Secret Binding 缺失或配置无效 | Gateway 安全错误，不发起上游请求 |
| 改写策略收到跨站/opaque Origin | 403 `EDGE_ORIGIN_NOT_ALLOWED`，不发起上游请求 |
| 上游正常返回 4xx/5xx | 状态、类型、Header、正文原样返回 |
| API/流式上游连接失败 | 502 `EDGE_UPSTREAM_UNAVAILABLE` JSON |
| 浏览器文档导航连接失败 | 502 Gateway 不可用 HTML |

## 入口和源站边界

生产 Wrangler 禁用 `workers.dev` 和 Preview URL。受 `entryAccess` 保护的 Cloudflare Custom Domain 只能从指定统一入口获得通行；Vercel Production URL 则必须通过 WAF 拒绝不带正确项目密钥的请求，Preview/Deployment URL 由 Vercel Standard Protection 或 Authentication 保护。两类限制覆盖不同入口，不能互相替代。完成外部配置并移除 Vercel 自定义域名后，Cloudflare Custom Domain 才是唯一正常业务入口。

本仓库实现 HTTP fetch 代理，不实现 WebSocket Upgrade。上游仍限定为 `https://*.vercel.app`，上游地址只能来自服务端路由配置。

## 源码和生成包

`src/worker.js` 是模块入口；配置和代理工具位于 `lib/`。Dashboard 部署使用生成的 `dashboard/worker.js`：

```bash
npm run dashboard:build
```

健康接口 `/_edge-gateway/health` 在统一入口及未受入口限制的域名返回构建编号，用于确认命中的 Production 版本。受 `entryAccess` 限制的 Demo 始终将该接口隐匿为 404，避免暴露 Gateway 类型和版本。
