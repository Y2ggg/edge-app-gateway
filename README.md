# Edge App Gateway

面向 Vercel 应用的零侵入 Cloudflare Workers 边缘网关：通过统一自定义域名入口提供多应用 Host 路由、可选密码访问、统一入口签名通行、隔离会话、源站保护和安全反向代理。

Zero-intrusion application gateway and reverse proxy for exposing multiple Vercel apps through Cloudflare Workers and custom domains.

## 为什么使用

多个个人或内部 Web 应用通常需要分别处理自定义域名、访问控制和源站暴露。Edge App Gateway 将这些入口能力集中到一个 Cloudflare Worker，外部应用无需安装 SDK、修改业务代码或迁移自身登录体系。

- **零侵入接入**：默认只需提供 Alias 和 Vercel Production URL。
- **多应用统一入口**：一个 Worker 根据精确 Host 路由多个应用。
- **独立访问策略**：每个应用可单独启用或关闭 Gateway 密码认证。
- **统一入口限制**：指定 Demo 必须由已认证入口签发短时票据；直接访问 Demo 自定义域名只得到无标识 404。
- **源站防绕过**：为每个 Vercel 项目注入独立 Secret，配合 Vercel WAF 拒绝直连。
- **全栈透明代理**：支持常用 HTTP 方法、流式请求与响应、应用 Cookie、Authorization 和重定向。
- **离线可视化配置**：在浏览器本地生成完整路由、Secrets、Custom Domains 和部署文件，不上传配置或凭据。

## 工作方式

```text
浏览器访问 alias.apps.example.com
                ↓
Cloudflare Worker 按 Host 选择应用
        ├─ 可选：验证统一入口签发的 Host 绑定通行
        ├─ 可选：验证 Gateway Edge Access
        ├─ 校验并按需改写 Origin / Referer
        └─ 注入该项目独立的 Origin Secret
                ↓
Vercel WAF 校验 Secret
                ↓
Vercel 应用及其原有登录、Cookie 和 Access Gate
```

Gateway 不替代上游应用认证。关闭 Edge Access 只会跳过 Gateway 登录，仍然可以代理完整请求并执行源站保护。

## 快速接入一个应用

已有 Gateway 时，新增应用通常只需要一次本地配置和一条 Vercel WAF 规则：

1. 在浏览器打开 [`cloudflare-worker/tools/config-generator.html`](./cloudflare-worker/tools/config-generator.html)。
2. 导入现有 `*.production.variables.json`，新增应用的 Alias 和 Vercel Production URL。
3. 生成并导出更新后的完整变量文件。
4. 根据生成结果在 Vercel 项目中添加请求头 WAF Rule，先使用 `Log`。
5. 从仓库根目录执行校验、dry-run 和部署：

   ```bash
   npm --prefix cloudflare-worker run deploy:config -- ../vercel-route.production.variables.json --check
   npm --prefix cloudflare-worker run deploy:config -- ../vercel-route.production.variables.json --dry-run
   npm --prefix cloudflare-worker run deploy:config -- ../vercel-route.production.variables.json
   ```

6. 确认自定义域名访问正常后，将 Vercel WAF Rule 切换为 `Deny`。

若 Demo 还要求“只能从统一入口项目点击进入”，请把入口项目和 Demo 放在同一份 Gateway 路由表中：入口启用 Edge Access，Demo 的 `entryAccess.entryAlias` 指向入口。入口页面使用相对路径 `/_edge-gateway/launch?target=<Demo 域名>&next=/`；Gateway 校验同源用户导航并签发单次兑换票据，入口无需保存 Session Secret。详见[配置与安全](./cloudflare-worker/docs/CONFIGURATION.md#统一入口访问控制)。

完整流程和首次部署前置条件见[快速开始](./cloudflare-worker/docs/QUICKSTART.md)与[部署手册](./cloudflare-worker/docs/DEPLOYMENT.md)。

> [!IMPORTANT]
> 变量文件包含生产 Secrets。不得提交到 Git；应限制文件权限并保存到密码保险库、加密磁盘或其他受控位置。更新应用时必须导入并修改现有完整配置，避免遗漏原有路由。

## 能力边界

- 上游目标限定为无凭据、查询和片段的 `https://*.vercel.app` URL。
- 当前实现 HTTP fetch 代理，不支持 WebSocket Upgrade。
- Gateway 不修改 HTML 或压缩后的 JavaScript 正文；应用不应在响应正文中硬编码必须保持的 Vercel 域名。
- 未配置 Vercel WAF 时基本代理功能仍可使用，但 Vercel Production URL 可以绕过 Gateway 直接访问。
- Cloudflare Custom Domain、Vercel WAF、Preview/Deployment URL 保护属于平台侧配置，不属于业务应用代码改造。

## 项目结构

```text
edge-app-gateway/
├── cloudflare-worker/
│   ├── src/                 # Worker 入口与认证逻辑
│   ├── lib/                 # 路由配置和代理工具
│   ├── tests/               # Node.js 测试
│   ├── tools/               # 离线可视化配置工具
│   ├── scripts/             # 配置部署、密钥生成和策略检查
│   ├── docs/                # 快速开始、部署、架构和配置文档
│   └── dashboard/worker.js  # 由源码生成的 Dashboard 单文件包
├── CONTRIBUTING.md
├── LICENSE
└── SECURITY.md
```

业务逻辑只维护在 `cloudflare-worker/src/` 和 `cloudflare-worker/lib/`；不要直接修改生成的 `dashboard/worker.js`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [快速开始](./cloudflare-worker/docs/QUICKSTART.md) | 首次部署与已有 Gateway 新增应用 |
| [部署手册](./cloudflare-worker/docs/DEPLOYMENT.md) | Cloudflare、Vercel WAF、验收与回滚 |
| [配置与安全](./cloudflare-worker/docs/CONFIGURATION.md) | 环境变量、路由协议、认证、代理和缓存 |
| [架构与边界](./cloudflare-worker/docs/ARCHITECTURE.md) | 请求流程、信任边界和错误行为 |
| [故障排查](./cloudflare-worker/docs/TROUBLESHOOTING.md) | 登录、域名、源站保护、Cookie 和缓存问题 |
| [贡献指南](./CONTRIBUTING.md) | 本地开发、测试和提交约定 |
| [安全策略](./SECURITY.md) | 漏洞报告与 Secret 处理要求 |

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。

## 本地开发

要求 Node.js 20 或更高版本。所有命令均在本地手动执行；本仓库不启用托管 CI/CD 或自动依赖更新。

```bash
npm --prefix cloudflare-worker install
npm --prefix cloudflare-worker run repository:check
npm --prefix cloudflare-worker run dashboard:build
npm --prefix cloudflare-worker test
npm --prefix cloudflare-worker run test:coverage
npm --prefix cloudflare-worker run deploy:check
```

真实域名、路由表、密码、散列、Session Secret、Origin Secret、运行数据和依赖目录不得提交到仓库。
