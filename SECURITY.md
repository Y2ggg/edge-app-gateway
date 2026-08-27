# 安全策略

Edge App Gateway 位于公开入口与上游应用之间。认证绕过、跨应用会话复用、Host 路由错误、源站 Secret 泄露、请求走私、开放重定向、缓存私有数据和任意上游访问都属于高优先级安全问题。

## 支持范围

安全修复面向 `main` 分支的最新代码和最新公开 Release。旧部署应先确认是否能够在当前版本复现问题。

## 报告漏洞

请勿为尚未修复的漏洞创建公开 Issue、Discussion 或 Pull Request。优先使用 GitHub 仓库的 Private vulnerability reporting；如果该入口不可用，请通过仓库维护者 GitHub 个人资料中公开且可验证的私密联系方式报告。

报告建议包含：

- 受影响的版本或 commit；
- 最小复现步骤和预期/实际行为；
- 影响范围及可能的绕过路径；
- 已脱敏的请求、响应或日志；
- 可行的修复建议（如有）。

不要发送真实 Session Secret、Origin Secret、访问密码、passwordHash、生产路由表或未脱敏的用户数据。必要时使用专门生成、可立即轮换的测试凭据。

## 部署方责任边界

Worker 注入 Origin Secret 不会自动阻止 Vercel 源站直连。需要在每个 Vercel 项目中配置 WAF，拒绝缺失或错误 Secret 的请求；否则 Gateway 的 Edge Access 和其他入口控制可以通过 Production URL 绕过。

`entryAccess` 只限制 Demo 的 Gateway Custom Domain：统一入口必须先通过 Edge Access；Worker 的 GET launch 同时验证入口会话、配置关系，以及浏览器的同源用户导航 Fetch Metadata，再签发绑定入口 Alias、目标 Alias、目标路径和用途的单次兑换票据。不要用 `Referer`、查询参数中的固定共享值或统一入口前端持有的 Secret 替代签名流程。Vercel Production URL 仍需上述 WAF 保护。

部署方还应：

- 保持 Cloudflare `workers.dev` 和 Preview URL 关闭；
- 使用 Vercel Standard Protection 或 Authentication 保护 Preview/Deployment URL；
- 为每个上游使用独立 Origin Secret；
- 定期轮换可能泄露的 Session Secret 和 Origin Secret；
- 将变量文件保存在访问受控且最好经过加密的位置；
- 确保认证响应保持 `private, no-store`，日志不包含敏感配置。

更完整的信任边界见[架构文档](./cloudflare-worker/docs/ARCHITECTURE.md)，生产配置要求见[部署手册](./cloudflare-worker/docs/DEPLOYMENT.md)。
