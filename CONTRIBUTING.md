# 贡献指南

感谢关注 Edge App Gateway。提交改动前，请先确认问题属于 Gateway 的职责范围：Cloudflare Worker Host 路由、边缘访问控制、Vercel 源站保护、HTTP 代理、离线配置生成或本地部署工具。

## 开发环境

项目要求 Node.js 20 或更高版本。安装依赖并运行本地 Worker：

```bash
npm --prefix cloudflare-worker install
npm --prefix cloudflare-worker run dev
```

真实变量写入本地 `.dev.vars`，不得提交。可从 `cloudflare-worker/.dev.vars.example` 创建仅包含测试值的本地文件。

## 代码边界

- Worker 模块源码位于 `cloudflare-worker/src/` 和 `cloudflare-worker/lib/`。
- 测试位于 `cloudflare-worker/tests/`，文件名使用 `*.test.js`。
- `cloudflare-worker/dashboard/worker.js` 是生成文件，不直接维护业务逻辑。
- 使用 JavaScript ES Modules、两个空格缩进、分号和单引号。
- 上游地址只能来自经过验证的服务端配置；不得记录域名路由、密码、散列或 Secret 值。
- 不任意修改压缩后的 JavaScript 或其他业务响应正文。

## 验证

提交前从仓库根目录运行：

```bash
npm --prefix cloudflare-worker run repository:check
npm --prefix cloudflare-worker run dashboard:build
npm --prefix cloudflare-worker test
npm --prefix cloudflare-worker run test:coverage
npm --prefix cloudflare-worker run deploy:check
```

认证、Cookie、Host 路由、重定向、Origin 改写、内容处理或目标校验的修改需要同时覆盖成功和失败路径。修改模块源码后必须重新生成 Dashboard 单文件包并运行其测试。

## 仓库自动化边界

本仓库使用 GitHub 进行版本管理、协作、tag 和 release，但不接受 `.github/workflows/`、Dependabot、Renovate 或其他托管 CI/CD 和自动依赖更新配置。构建、测试、打包和部署验证均在本地手动执行。

## 提交和合并请求

提交信息使用 Conventional Commits，例如：

```text
feat(tool): simplify application onboarding
fix(worker): preserve upstream cookies
docs: clarify Vercel WAF setup
```

合并请求应说明：

- 改动目的和能力边界；
- 执行过的验证命令；
- 是否改变环境变量、Custom Domain、Vercel WAF 或其他外部状态；
- 对现有配置文件协议和部署流程的兼容性影响。

安全漏洞不要通过公开 Issue 报告，请遵循[安全策略](./SECURITY.md)。
