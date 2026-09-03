# 配置与安全

## 环境变量和 Binding

| 名称 | 必需 | 约束 |
| --- | --- | --- |
| `ROUTE_PROJECTS_JSON` | 是 | 1–200 个应用组成的新协议 JSON 映射，生产环境建议存为 Secret |
| `ROUTE_BASE_DOMAIN` | 多应用必需 | 仅域名，例如 `apps.example.com`，不含协议、端口、路径或通配符 |
| `ROUTE_SESSION_SECRET` | 存在 Edge Access required 路由或 entryAccess required 关系时必需 | 至少 32 个字符，用于密码 HMAC、alias 绑定的 Session 以及统一入口票据签名 |
| `ROUTE_SESSION_TTL_SECONDS` | 否 | 300–604800，默认 28800 秒 |
| 路由中的 `secretBinding` | Origin Protection required 时必需 | Binding 名进入 JSON，Secret 值单独保存在 Cloudflare |
| `EDGE_LOGIN_RATE_LIMITER` | 建议 | Wrangler 已配置为每 IP+alias 每分钟最多 5 次登录提交；另有 isolate 内失败计数兜底 |

一个上游一个 Secret，不复用：例如 `ORIGIN_SECRET_PROJECT_A`、`ORIGIN_SECRET_PROJECT_B`。Secret 值不能进入 JSON、日志、响应、Git 或截图。

本地 `tools/config-generator.html` 可同时维护 1–200 个应用。工具按“Gateway、应用、部署结果”三个步骤工作，应用列表中一次只展开一个编辑器。每个应用都要明确选择“普通应用”或“统一入口应用”，并填写语义化别名；普通应用必须填写访问域名 Alias，统一入口应用的访问域名 Alias 可留空。点击唯一的“生成全部配置”后，工具统一校验所有应用并补齐需要的 Session Secret、passwordHash、Origin Secret、Custom Domain、Binding、安全默认策略、完整路由表和逐项目 WAF Secret；统一入口不填写访问域名 Alias 时，基础域名自动成为它的 Custom Domain。导入只恢复编辑状态，不会静默生成或导出；生成器完全离线，不使用 localStorage、sessionStorage 或 IndexedDB。

工具导出的 `*.production.variables.json` 同时是敏感备份和 `deploy:config` 的输入，包含普通变量、完整路由表、Session Secret、所有 Origin Secret 和 Custom Domains。统一入口角色和访问域名 Alias 都直接写入路由表；统一入口不填写 Alias 时，裸基础域名（例如 `https://apps.example.com`）就是它的入口。它可以保存在受控 WebDAV 目录，但 WebDAV 必须使用 HTTPS、独立凭据和严格访问控制；若服务端不是端到端加密，文件应额外加密。推荐通过系统挂载或同步客户端提供本地路径，生成器不直接保存 WebDAV 凭据或连接远端。默认部署流程从 `edge-app-gateway` 仓库根目录运行 `npm --prefix cloudflare-worker run deploy:config -- ../<文件名> --worker '<Worker 名>'`；生成器会输出校验、dry-run、正式部署和健康检查的完整命令，并保证命令中的 Worker 名与下载文件内容一致。

变量文件协议为版本化 JSON：

```json
{
  "format": "edge-app-gateway.variables",
  "version": 1,
  "worker": {
    "name": "lx-cm-route",
    "rateLimitNamespaceId": "1001",
    "customDomains": ["portal.apps.example.com"]
  },
  "vars": {
    "ROUTE_BASE_DOMAIN": "apps.example.com",
    "ROUTE_SESSION_TTL_SECONDS": "28800"
  },
  "secrets": {
    "ROUTE_PROJECTS_JSON": "<完整 JSON 字符串>",
    "ROUTE_SESSION_SECRET": "<存在 Edge Access required 路由或 entryAccess required 关系时存在>",
    "ORIGIN_SECRET_PORTAL": "<项目独立 Secret>"
  }
}
```

若要启用裸基础域名统一入口，在路由表中把入口应用标记为 `"isUnifiedEntry": true`，并省略它的 `hostnameAlias`；对应 `worker.customDomains` 必须包含 `apps.example.com`。

`worker.name` 是正式部署的 Worker 目标，而不是仅用于显示的名称。命令必须显式提供相同的 `--worker`，不一致时部署脚本会拒绝继续。`worker.rateLimitNamespaceId` 是该 Worker 的账号级登录限流命名空间；不同逻辑 Worker 必须使用不同值，否则 Cloudflare 会共享相同 key 的限流计数。默认 Worker `lx-cm-route` 在从旧名称迁移时沿用 `1001`，其他名称由生成器稳定生成。部署脚本根据变量文件生成仅在本次命令中使用的私有临时 Wrangler 配置，完成或失败后都会删除。

明文 Gateway 密码不会进入变量文件，只保存使用 Session Secret 生成的 `passwordHash`。CLI 部署脚本会重新校验路由与文件字段，并通过 Wrangler 标准输入上传 Secrets。

## 路由协议

```json
{
  "data-app": {
    "semanticAlias": "data-app",
    "isUnifiedEntry": false,
    "hostnameAlias": "data",
    "target": "https://data-app.vercel.app",
    "deliveryMode": "proxy",
    "proxyProfile": "fullstack",
    "requestOriginPolicy": "rewrite-to-upstream",
    "edgeAccess": {
      "mode": "disabled"
    },
    "entryAccess": {
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

- 每个应用都有唯一的语义化别名（配置映射键）。`isUnifiedEntry` 必须明确区分普通应用（`false`）和统一入口应用（`true`）；普通应用必须配置 `hostnameAlias`，统一入口应用可选，省略时裸 `apps.example.com` 就是它的入口。
- `semanticAlias` 与配置映射键保持一致，用于统一入口选择和票据绑定；`isUnifiedEntry=true` 明确标记统一入口应用，整份配置最多一个。
- 普通应用的 `hostnameAlias` 必填；统一入口应用的 `hostnameAlias` 可选，填写后域名为 `hostnameAlias.apps.example.com`，留空则使用 `apps.example.com`。
- `target` 必须是无凭据、查询和片段的 `https://*.vercel.app` URL，可包含固定基础路径。
- `deliveryMode` 为 `proxy` 或显式 `redirect`。Edge Access disabled 不会自动改变该字段。
- `proxyProfile` 为 `static` 或 `fullstack`。static 只能允许 GET、HEAD、OPTIONS；fullstack 可使用全部受支持方法。
- `requestOriginPolicy` 可省略，默认 `preserve`。`rewrite-to-upstream` 只改写原本与用户自定义域名同源的 Origin/Referer，适用于按 Vercel Host 校验同源的上游 Access Gate。redirect 模式不能使用改写策略。
- `edgeAccess.mode` 为 `disabled` 或 `required`。required 必须有 `edgeAccess.passwordHash`；disabled 时该字段不读取，也不会单独要求 `ROUTE_SESSION_SECRET`。若配置了 `entryAccess=required`，统一入口票据仍需要该 Secret。
- `entryAccess` 可省略，默认 `{ "mode": "disabled" }`。`required` 必须提供另一个已配置统一入口应用的语义化别名 `entryAlias`，以及可选的 `ttlSeconds`（300–86400，默认 1800）。目标与入口都必须使用 proxy；入口不能再依赖其他入口。入口是否启用 Gateway 密码由入口自己的 `edgeAccess` 独立决定。
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
- `GET /_edge-gateway/health`（受统一入口限制的 Demo 隐匿该接口）
- `GET /_edge-gateway/launch`（统一入口校验同源用户导航并签发 30 秒票据）
- `GET /_edge-gateway/entry`（目标应用验票并建立通行会话）

登录 POST 必须提供同源 `Origin`，或在 Origin 缺失时提供同源 `Referer`。失败、未知 alias 和错误密码使用相同页面和日志消息。失败尝试按客户端 IP+alias 限制；生产部署同时使用 `EDGE_LOGIN_RATE_LIMITER` Binding，内存计数仅作为补充。

`route_session` 为无 Domain 的 Host-only Cookie，设置 `Path=/; HttpOnly; Secure; SameSite=Lax`。alias 写入签名 Token，因此其他 alias 的 Token 无效。当前路由按独立主机承载 alias，`Path=/` 正是该 alias 主机可用的最窄业务路径。转发前删除 Gateway 自己的 `route_session` 和 `entry_session`，其他 Cookie 保留。

使用当前会话密钥生成密码散列：

```bash
npm run password:hash -- "访问密码" "ROUTE_SESSION_SECRET"
```

更换 `ROUTE_SESSION_SECRET` 会使所有现有 Session 和密码散列失效；required 路由需要重新生成散列。

## 统一入口访问控制

统一入口项目必须作为 `deliveryMode=proxy` 的应用接入 Gateway；`edgeAccess.mode` 可按需选择 `required` 或 `disabled`，不影响它被其他应用引用为统一入口。受保护 Demo 的示例：

```json
{
  "portal": {
    "semanticAlias": "portal",
    "isUnifiedEntry": true,
    "hostnameAlias": "",
    "target": "https://portal-app.vercel.app",
    "deliveryMode": "proxy",
    "proxyProfile": "fullstack",
    "requestOriginPolicy": "rewrite-to-upstream",
    "edgeAccess": { "mode": "required", "passwordHash": "<HMAC 散列>" },
    "entryAccess": { "mode": "disabled" },
    "originProtection": {
      "mode": "required",
      "headerName": "x-edge-app-gateway-origin",
      "secretBinding": "ORIGIN_SECRET_PORTAL"
    },
    "allowedMethods": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    "cachePolicy": "no-store",
    "cookieDomainPolicy": "strip"
  },
  "demo-app": {
    "semanticAlias": "demo-app",
    "isUnifiedEntry": false,
    "hostnameAlias": "demo-app",
    "target": "https://demo-app.vercel.app",
    "deliveryMode": "proxy",
    "proxyProfile": "fullstack",
    "requestOriginPolicy": "rewrite-to-upstream",
    "edgeAccess": { "mode": "disabled" },
    "entryAccess": { "mode": "required", "entryAlias": "portal", "ttlSeconds": 1800 },
    "originProtection": {
      "mode": "required",
      "headerName": "x-edge-app-gateway-origin",
      "secretBinding": "ORIGIN_SECRET_DEMO_APP"
    },
    "allowedMethods": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    "cachePolicy": "no-store",
    "cookieDomainPolicy": "strip"
  }
}
```

入口页面链接到当前入口 Host 的相对地址：

```text
/_edge-gateway/launch?target=demo-app.apps.example.com&next=%2F
```

若入口启用了 `edgeAccess=required`，Gateway 先验证入口 Host 的 `route_session`；入口关闭 Edge Access 时跳过这一步，但两种模式都会继续验证配置中的入口→目标关系。对提供 Fetch Metadata 的现代浏览器，launch 还必须是 `same-origin`、`navigate`、`document` 且带有真实用户激活标记 `Sec-Fetch-User: ?1`；地址栏直开、F12 fetch、无用户手势的脚本导航和跨站触发均被隐匿拒绝。对完全不提供 Fetch Metadata 的旧客户端，仅兼容同源 Referer；Referer 不作为现代浏览器的授权替代品。

校验通过后，Gateway 签发 30 秒的随机紧凑票据。票据正文不包含可解码的入口 Alias、目标 Alias、路径或用途；这些上下文与随机 nonce、过期时间共同参与 HMAC，因而票据不能跨入口、跨目标、跨路径或跨用途使用。目标 `/_edge-gateway/entry` 验票后通过 `ENTRY_TICKET_REDEEMER` Durable Object 原子消费票据；同一票据再次使用会得到隐匿 404。首次兑换会设置无 Domain 的 Host-only `entry_session`，有效期由目标的 `ttlSeconds` 决定。

目标普通请求缺少、过期或 Alias 不匹配的通行 Cookie时，不返回 Gateway JSON 或权限提示：文档导航得到中性的“页面无法打开”404，API、静态资源和 favicon 得到空正文 404。错误票据、伪造 `Referer`、未授权的登录/会话接口和受限 Demo 的健康接口使用同样的隐匿响应。响应强制 `private, no-store`、`no-referrer`、禁止索引，并使用仅允许内联页面样式、拒绝其他资源和嵌入的 CSP。

`entryAccess` 不替代两类已有控制：目标自身若还启用 Edge Access，访客通过统一入口后仍需完成目标密码验证；Vercel Production URL 是否能绕过 Gateway，仍由该项目的 Vercel WAF Origin Secret 规则决定。

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
