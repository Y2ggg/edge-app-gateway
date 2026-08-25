# 快速开始

本指南覆盖两个最常见场景：向已有 Edge App Gateway 接入一个 Vercel 应用，以及首次部署 Gateway。外部应用无需安装依赖或修改业务代码；接入工作发生在 Gateway、Cloudflare 和 Vercel 配置层。

## 前置条件

- Node.js 20 或更高版本。
- 一个 Cloudflare 账号及已托管到该账号的基础域名 Zone。
- 一个可访问的 Vercel Production URL，例如 `https://portal-app.vercel.app`。
- 首次正式部署时，Wrangler 已登录拥有目标 Zone 和 Workers 权限的 Cloudflare 账号。

安装本地依赖：

```bash
npm --prefix cloudflare-worker install
```

## 向已有 Gateway 新增应用

### 1. 导入现有配置

在浏览器本地打开 `cloudflare-worker/tools/config-generator.html`，导入当前使用的 `*.production.variables.json`。

变量文件是完整配置，而不是单个应用的增量文件。不要从空白页面只生成新应用，否则导出的路由清单不会包含原有应用。

### 2. 添加应用

默认情况下只需填写：

- **Alias**：自定义域名的第一级名称，例如 `portal`。
- **Vercel Production URL**：例如 `https://portal-app.vercel.app`。

工具会自动生成或补齐：

- `portal.<ROUTE_BASE_DOMAIN>` Custom Domain；
- 项目独立的 Origin Secret 和 Cloudflare Secret Binding；
- 完整 `ROUTE_PROJECTS_JSON`；
- 安全代理默认值；
- Vercel WAF 所需的 Header 名和值。

只有需要 Gateway 密码访问时，才启用 Edge Access 并输入该应用的访问密码。上游应用自己的登录和 Cookie 不需要写入 Gateway 配置。

### 3. 生成并保存变量文件

点击“生成全部配置”，检查应用数量、Custom Domains 和 Secret Binding 名称后，导出更新后的 `*.production.variables.json`。

该文件包含生产 Secrets：

```bash
chmod 600 vercel-route.production.variables.json
```

文件不得提交到 Git。建议保存到密码保险库、加密磁盘或其他受控位置。

### 4. 添加 Vercel WAF Rule

在生成结果的“Vercel WAF”页签中找到该应用的 Header 名和值，并在对应 Vercel 项目中添加规则。首次配置先使用 `Log`，避免错误 Secret 导致应用不可用。

```text
IF Request Header x-edge-app-gateway-origin
   Does not equal <该项目 Origin Secret>
THEN Log
```

如果 Vercel 的 `Does not equal` 不匹配“Header 缺失”，使用“正确 Header Allow/Bypass + 其他请求 Deny”两条规则。不要使用 `x-vercel-protection-bypass` 作为普通源站密钥。

### 5. 校验并部署

从仓库根目录运行生成器给出的命令：

```bash
npm --prefix cloudflare-worker run deploy:config -- ../vercel-route.production.variables.json --check
npm --prefix cloudflare-worker run deploy:config -- ../vercel-route.production.variables.json --dry-run
npm --prefix cloudflare-worker run deploy:config -- ../vercel-route.production.variables.json
```

正式部署会同时更新 Worker 代码、普通变量、Secrets 和全部 Custom Domains。配置文件中删除的旧 Secret 不会被自动清理，避免误删仍在使用的远端 Secret。

### 6. 验收并收紧源站

访问健康接口：

```text
https://portal.apps.example.com/_edge-gateway/health
```

随后验证页面、静态资源、API、应用登录和退出。确认 Worker 请求在 Vercel WAF 日志中携带正确 Header 后，将规则从 `Log` 切换为 `Deny`。

最终应满足：

- 自定义域名能够正常访问应用；
- 错误或缺失 Origin Secret 的 Vercel Production URL 请求被拒绝；
- Preview/Deployment URL 由 Vercel Standard Protection 或 Authentication 保护；
- Edge Access required 的应用无法通过 Vercel Production URL 绕过 Gateway 登录。

## 首次部署 Gateway

首次部署还需要确定 Worker 名称、`ROUTE_BASE_DOMAIN` 和 Cloudflare Zone，并登录 Wrangler：

```bash
cd cloudflare-worker
npx wrangler whoami
npx wrangler login
cd ..
```

然后在配置工具中创建第一份完整配置，按本指南的 WAF、校验、dry-run、部署和验收顺序操作。生产环境必须保持 `workers_dev=false` 和 `preview_urls=false`。

Cloudflare 权限、Vercel WAF 阶段切换、唯一入口检查和回滚步骤见[完整部署手册](./DEPLOYMENT.md)。配置字段说明见[配置与安全](./CONFIGURATION.md)。

## 兼容性边界

零侵入接入适用于普通 HTTP Vercel 应用。以下情况需要额外评估：

- WebSocket Upgrade 当前不受支持；
- 响应正文中硬编码 Vercel 绝对域名时，Gateway 不会修改 HTML 或 JavaScript；
- 依赖第三方 OAuth、Webhook 或域名白名单时，第三方平台可能需要登记新的自定义域名；
- 不配置 Vercel WAF 不影响基本代理，但会保留绕过 Gateway 的源站直连入口。
