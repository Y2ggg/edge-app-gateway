# Cloudflare Vercel Route

本仓库仅包含 [`cloudflare-worker/`](./cloudflare-worker/) 项目：一个通过 Host 路由、密码认证并代理 Vercel 上游的 Cloudflare Worker。

- Wrangler 源码入口：`cloudflare-worker/src/worker.js`
- Dashboard 单文件入口：`cloudflare-worker/dashboard/worker.js`
- 配置与使用说明：[`cloudflare-worker/README.md`](./cloudflare-worker/README.md)
- 无 npm 部署说明：[`cloudflare-worker/CLOUDFLARE_DEPLOYMENT.md`](./cloudflare-worker/CLOUDFLARE_DEPLOYMENT.md)

开发、测试和部署命令均在 `cloudflare-worker/` 目录内运行。真实环境变量、域名、路由表、密码散列和会话密钥不得提交到仓库。
