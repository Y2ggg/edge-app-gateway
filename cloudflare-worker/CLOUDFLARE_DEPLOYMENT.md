# Cloudflare 与 Vercel 部署手册

本手册使用 Wrangler CLI 管理 Cloudflare Worker，不依赖 Cloudflare Dashboard。任何真实路由表、密码、散列、域名、Session Secret 或 Origin Secret 都只进入受控配置，不进入 Git。

## 1. 仓库发布前检查

```bash
npm install
npm run dashboard:build
npm test
npm run test:coverage
npm run deploy:check
```

生产 `wrangler.jsonc` 必须保持：

```json
{
  "workers_dev": false,
  "preview_urls": false
}
```

本地 `wrangler dev` 不需要开放生产 Preview URL。若团队确需远程开发 Preview，请另建不参与生产部署的开发配置，不能把生产开关改回 true。

## 2. 准备配置和密钥

1. 运行 `npm run session:secret` 生成 `ROUTE_SESSION_SECRET`。只有存在 Edge Access required 路由时才需要。
2. 为每个 required Edge Access 路由生成独立访问密码散列：

   ```bash
   npm run password:hash -- "访问密码" "ROUTE_SESSION_SECRET"
   ```

3. 为每个 Vercel 项目分别生成至少 32 个随机字符的 Origin Secret，禁止复用。
4. 按[配置协议](./docs/CONFIGURATION.md)准备完整 `ROUTE_PROJECTS_JSON`。配置只能写 Binding 名，不能写 Origin Secret 值。
5. 在本地打开 `tools/config-generator.html`，填写 Worker 名称、统一基础域名，并在应用列表中同时维护 1–200 个项目。每个项目默认只需 Alias 和 Vercel Production URL；工具自动生成 Custom Domain、Binding、Origin Secret、完整路由表及 Vercel WAF 清单。
6. 导出 `*.production.variables.json`。这是包含全部生产 Secret 的敏感备份和 CLI 部署输入，不得提交 Git。可存入密码保险库、加密磁盘，或通过 WebDAV 客户端同步到使用 HTTPS 和独立账号保护的私有目录。生成器本身保持离线，不直接连接 WebDAV。

示例仅使用占位符：

```json
{
  "portal": {
    "target": "https://portal-app.vercel.app",
    "deliveryMode": "proxy",
    "proxyProfile": "fullstack",
    "requestOriginPolicy": "rewrite-to-upstream",
    "edgeAccess": { "mode": "disabled" },
    "originProtection": {
      "mode": "required",
      "headerName": "x-edge-app-gateway-origin",
      "secretBinding": "ORIGIN_SECRET_PORTAL"
    },
    "allowedMethods": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    "cachePolicy": "assets-only",
    "cookieDomainPolicy": "strip"
  }
}
```

## 3. 使用 Wrangler CLI 部署 Worker

首次操作先安装依赖，再核对 Wrangler 账号与现有 Binding：

```bash
cd cloudflare-worker
npm install
npx wrangler whoami
npx wrangler secret list --name vercel-route
cd ..
```

变量文件可以位于本地磁盘或已挂载/同步的 WebDAV 目录。以下推荐流程统一从 `edge-app-gateway` 仓库根目录执行；先校验，再 dry-run，最后部署：

```bash
chmod 600 vercel-route.production.variables.json
npm --prefix cloudflare-worker run deploy:config -- ../vercel-route.production.variables.json --check
npm --prefix cloudflare-worker run deploy:config -- ../vercel-route.production.variables.json --dry-run
npm --prefix cloudflare-worker run deploy:config -- ../vercel-route.production.variables.json
```

`npm --prefix` 会让部署脚本在 `cloudflare-worker/` 内运行，因此根目录变量文件参数使用 `../<文件名>`。部署脚本会从自身位置自动定位 Worker 和 Wrangler，校验文件版本、路由协议、Secret Binding、Alias、基础域名及全部 Custom Domains。Secret JSON 只写入 Wrangler 标准输入，不出现在命令行参数或脚本日志中。普通变量使用 `--var`，每个精确域名使用一个 `--domain`；Rate Limiter、`workers_dev=false` 和 `preview_urls=false` 继续由 `wrangler.jsonc` 管理。

`--check` 完全在本地执行，不检查登录、不访问 Cloudflare。`--dry-run` 调用 Wrangler 构建但不会正式部署。正式部署成功后，脚本会输出 Worker 名称、Version ID、Custom Domains、Secret Binding 名称和逐域名健康检查命令；任何输出都会过滤已知 Secret 值。

只有 disabled Edge Access 路由时可以省略 `ROUTE_SESSION_SECRET`。每个 `originProtection.secretBinding` 都必须在文件的 `secrets` 中存在，否则脚本拒绝部署。

Wrangler 的 `--secrets-file` 是增量写入：从变量文件移除项目后，旧的未引用 Secret 不会自动删除。确认已无路由使用后，再显式执行 `npx wrangler secret delete <NAME> --name <WORKER>`；不要在自动部署中盲目清理远端 Secret。

部署后访问：

```text
https://portal.apps.example.com/_edge-gateway/health
```

确认 build 为 `2026-08-21-gateway-v5`。

## 4. 配置 Vercel WAF 源站保护

每个项目单独配置规则，Header 名和值必须与对应 Worker 路由一致。不要使用 `x-vercel-protection-bypass` 充当普通源站密钥。

第一阶段先设为 Log：

```text
IF Request Header x-edge-app-gateway-origin
   Does not equal <该项目 Origin Secret>
THEN Log
```

通过 Cloudflare 自定义域名访问页面、静态资源和 API，确认 Worker 请求均带正确 Header；同时直连 Vercel，确认缺失及错误 Header 都命中日志。

如果实测发现“Header 缺失”不触发 Does not equal，不得切换单规则 Deny。改为两条规则：

1. Header 等于正确 Secret 时 Allow/Bypass 后续源站拒绝规则。
2. 其他所有请求 Deny。

确认日志无误后才把保护切换到 Deny。然后启用 Vercel Standard Protection/Authentication 保护 Preview 和 Deployment URL。Production URL 由 WAF 拒绝直连；不要让 Vercel Protection 阻断已经携带正确项目密钥的 Worker 请求。

## 5. 关闭额外入口

逐项确认：

- Cloudflare `workers.dev` 无法访问。
- Cloudflare Preview URL 无法访问。
- Vercel Production URL 在缺失或错误 Origin Secret 时被拒绝。
- Vercel Preview/Deployment URL 由 Vercel Authentication 或 Standard Protection 保护。
- Vercel 项目不再绑定面向用户的自定义域名。
- Cloudflare 精确 Custom Domain 是唯一正常业务入口。

这些是账号级外部状态，无法仅凭仓库测试证明；必须在真实环境记录验收结果。

## 6. 线上回归

将占位域名替换为受控测试目标，不要把命令输出中的敏感 Header 保存到日志：

```bash
curl -i https://project-name.vercel.app/
curl -i -H 'x-edge-app-gateway-origin: wrong' https://project-name.vercel.app/
curl -i https://portal.apps.example.com/
```

预期前两项被 Vercel 拒绝，第三项经 Worker 到达上游应用或它自己的 Access Gate。随后验证：

- Gateway Edge Access required/disabled 两类路由。
- 上游应用登录、退出、刷新和应用 Cookie；启用 `rewrite-to-upstream` 时确认上游不再返回 `ORIGIN_NOT_ALLOWED`。
- GET、HEAD、POST、PUT、PATCH、DELETE、OPTIONS 与 405 Allow。
- API JSON 错误状态不转成 HTML。
- NDJSON/SSE 首块在流结束前到达，且 `Cache-Control: no-store`。
- 多个 Set-Cookie、Location 和显式 Cookie Domain 行为。
- 静态资源可缓存，API、流式、Authorization 和应用 Session 请求不缓存。
- 直接访问 Vercel 的页面、静态资源和 API 均被拒绝。

## 7. 发布和回滚

代码更新时重新生成 Dashboard 包并完成四条验证命令。Wrangler 部署可按 Cloudflare Deployment 回滚代码；变量、Secret、Rate Limiter、Custom Domain 和 Vercel WAF 是外部状态，需要单独保存变更记录和回滚步骤。
