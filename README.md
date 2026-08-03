# Edge App Gateway

一个轻量级边缘应用接入网关，为多个 Web 应用统一提供自定义域名入口、Host 分流、独立密码认证、会话隔离和安全反向代理。它把应用入口治理集中在边缘层，让新增应用只需要配置映射和域名，不必在每个应用中重复实现访问控制。

当前实现运行在 Cloudflare Workers 上，并适配公开的 Vercel 静态部署作为上游。Cloudflare 和 Vercel 是当前运行与上游边界，不定义项目本身的用途。

- Wrangler 源码入口：`cloudflare-worker/src/worker.js`
- Dashboard 单文件入口：`cloudflare-worker/dashboard/worker.js`
- 配置与使用说明：[`cloudflare-worker/README.md`](./cloudflare-worker/README.md)
- 无 npm 部署说明：[`cloudflare-worker/CLOUDFLARE_DEPLOYMENT.md`](./cloudflare-worker/CLOUDFLARE_DEPLOYMENT.md)

开发、测试和部署命令均在 `cloudflare-worker/` 目录内运行。真实环境变量、域名、应用映射、密码散列和会话密钥不得提交到仓库。
