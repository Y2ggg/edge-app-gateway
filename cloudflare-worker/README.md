# Edge App Gateway for Cloudflare Workers

这是 Edge App Gateway 的 Cloudflare Workers 实现。它在应用之前建立统一的边缘接入层，为多个 Web 应用提供独立域名入口、按 Host 选择应用、密码认证、隔离会话和安全反向代理。每个应用使用一个精确 Custom Domain，例如 `portal.demo.example.com`；新增应用时只需更新服务端映射并在同一 Worker 下添加域名。

## 核心能力

- 使用免费额度内的普通 Worker，不需要 Pages 或 Workers for Platforms。
- 使用 Dashboard 粘贴 [`dashboard/worker.js`](./dashboard/worker.js)，部署过程不依赖本地 npm。
- 集中管理多个应用入口，并通过请求 Host 选择对应上游。
- 每应用独立密码；HMAC-SHA256 散列与服务端 `ROUTE_SESSION_SECRET` 绑定。
- 登录后签发按应用隔离的 `HttpOnly`、`Secure` 会话 Cookie。
- 默认不改写上游正文，JavaScript、HTML 和其他静态资源保持原样传输。

当前上游适配器只接受公开的 `https://*.vercel.app`，并只代理浏览器的 GET/HEAD 请求。这是当前实现的能力边界，不是项目定位。

## 目录

| 路径 | 用途 |
| --- | --- |
| `dashboard/worker.js` | 可直接粘贴到 Cloudflare Dashboard 的最终单文件包 |
| `src/`、`lib/` | Worker 源码和应用分流、认证、代理逻辑 |
| `tools/config-generator.html` | 离线生成密钥、密码散列并检查配置 |
| `tests/` | Node.js 测试 |
| `CLOUDFLARE_DEPLOYMENT.md` | 从零部署及新增应用步骤 |
| `docs/` | 配置、安全、架构和故障排查 |

## 开始使用

不使用命令行时，直接按照[部署手册](./CLOUDFLARE_DEPLOYMENT.md)操作。密码、散列、密钥、真实域名和完整应用映射不得提交到仓库。

本地开发：

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

维护和验证：

```bash
npm run dashboard:build
npm test
npm run test:coverage
npm run deploy:check
```

`dashboard/worker.js` 是生成文件。修改 `src/` 或 `lib/` 后必须重新执行 `npm run dashboard:build`，并一并提交源码、测试和单文件包。

## 文档

- [部署与新增应用](./CLOUDFLARE_DEPLOYMENT.md)
- [配置与安全](./docs/CONFIGURATION.md)
- [架构与能力边界](./docs/ARCHITECTURE.md)
- [故障排查](./docs/TROUBLESHOOTING.md)
