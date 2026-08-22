# Edge App Gateway

一个轻量级边缘应用接入网关，为多个 Web 应用统一提供自定义域名入口、Host 分流、独立密码认证、会话隔离和安全反向代理。它把应用入口治理集中在边缘层，让新增应用只需要配置映射和域名，不必在每个应用中重复实现访问控制。

当前实现运行在 Cloudflare Workers 上，并适配公开的 Vercel 静态部署作为上游。Cloudflare 和 Vercel 是当前运行与上游边界，不定义项目本身的用途。

- Wrangler 源码入口：`cloudflare-worker/src/worker.js`
- Dashboard 单文件入口：`cloudflare-worker/dashboard/worker.js`
- 配置与使用说明：[`cloudflare-worker/README.md`](./cloudflare-worker/README.md)
- 无 npm 部署说明：[`cloudflare-worker/CLOUDFLARE_DEPLOYMENT.md`](./cloudflare-worker/CLOUDFLARE_DEPLOYMENT.md)

开发、测试和部署命令均在 `cloudflare-worker/` 目录内运行。真实环境变量、域名、应用映射、密码散列和会话密钥不得提交到仓库。

## 仓库协作与发布策略

GitHub 只用于代码存储、版本管理、代码协作、分支、tag 和 release。本仓库不使用 GitHub Actions、Dependabot 自动更新或其他托管 CI/CD；push、pull request 或 tag 不会自动执行构建、测试、打包、依赖升级或发布。

所有验证均在本地按需手动执行。进入 `cloudflare-worker/` 后，至少先运行仓库策略检查，再按改动范围执行构建、测试和部署 dry-run：

```bash
npm run repository:check
npm run dashboard:build
npm test
npm run test:coverage
npm run deploy:check
```

Release 资产必须在本地生成并验证，再手动创建或更新 GitHub Release 并上传；push、pull request、tag 或 release 本身均不代表已完成验证，也不会触发远端自动化。
