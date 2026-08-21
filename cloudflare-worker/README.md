# Edge App Gateway for Cloudflare Workers

Edge App Gateway 是面向 Vercel 应用的 Cloudflare Worker 全栈入口。浏览器始终停留在自定义域名；Worker 可选执行边缘登录、代理完整 HTTP 请求、为每个上游注入独立源站密钥，并以流式正文返回响应。上游应用自己的 Access Gate、登录和 Cookie 不属于 Gateway 配置，也不会被 Gateway 删除或替代。

四项职责彼此独立：

- `edgeAccess`：是否由 Gateway 验证访问者；`disabled` 仍然走 Worker 代理。
- `originProtection`：是否注入 Vercel WAF 校验的项目独立密钥。
- `proxyProfile`：声明静态或全栈代理能力。
- Application Access：完全由上游应用管理，不写入 Gateway 路由表。

## 核心能力

- 通过请求 Host 选择应用，支持一个 Worker 绑定多个精确 Custom Domain。
- 支持 GET、HEAD、POST、PUT、PATCH、DELETE 和 OPTIONS，并按路由返回严格的 405/`Allow`。
- 可按路由将可信同源浏览器请求的 Origin/Referer 改写为上游 Origin，使按 Host 校验同源的上游 Access Gate 正常登录和退出；跨站 Origin 在边缘拒绝。
- 请求体与响应体均使用 Web Streams 直接透传；Worker 不解析业务 JSON、NDJSON 或表单正文。
- 保留 Authorization、应用 Cookie、状态码、Content-Type、Location、缓存头及多个 Set-Cookie。
- 删除 hop-by-hop Header、客户端伪造的源站保护 Header 和 Gateway 自己的 `route_session`。
- 仅上游连接失败的浏览器文档导航显示不可用页面；业务 4xx/5xx 原样返回。
- `assets-only` 只允许无认证静态资源缓存，API、NDJSON、SSE、登录和会话一律 `no-store`。
- 生产 Wrangler 配置关闭 `workers.dev` 和 Preview URL。

## 目录

| 路径 | 用途 |
| --- | --- |
| `src/`、`lib/` | Worker 模块源码和配置、代理逻辑 |
| `tests/` | 配置、认证、全栈代理、流式与安全测试 |
| `dashboard/worker.js` | 从模块源码生成的 Dashboard 单文件包 |
| `tools/config-generator.html` | 完全离线的密码散列与配置检查工具 |
| `CLOUDFLARE_DEPLOYMENT.md` | Cloudflare、Vercel WAF 和上线验收步骤 |
| `docs/` | 配置协议、架构和故障排查 |

## 本地开发与验证

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

提交前执行：

```bash
npm run dashboard:build
npm test
npm run test:coverage
npm run deploy:check
```

`dashboard/worker.js` 是生成文件，业务逻辑只维护在 `src/` 和 `lib/`。`.dev.vars`、真实域名、完整生产路由表、密码、散列、会话密钥和源站密钥不得提交。

详细说明见[配置与安全](./docs/CONFIGURATION.md)、[架构](./docs/ARCHITECTURE.md)、[部署手册](./CLOUDFLARE_DEPLOYMENT.md)和[故障排查](./docs/TROUBLESHOOTING.md)。
