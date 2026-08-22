# Repository Guidelines

## 项目结构与边界

`cloudflare-worker/` 是使用 Wrangler 部署的 Cloudflare Worker 项目。模块源码位于 `src/` 与 `lib/`，测试位于 `tests/`，`dashboard/worker.js` 是由源码生成、可粘贴到 Cloudflare Dashboard 的单文件包。不要在生成文件中直接维护业务逻辑。

## 开发、测试与部署命令

进入 `cloudflare-worker/` 后执行：

- `npm install`：按锁文件安装依赖。
- `npm test`：运行 Node.js 测试。
- `npm run test:coverage`：输出覆盖率。
- `npm run dev`：启动 Wrangler 本地环境。
- `npm run repository:check`：拒绝托管 CI/CD 和自动依赖更新配置。
- `npm run password:hash -- "密码" "ROUTE_SESSION_SECRET"`：生成与会话密钥绑定的 HMAC 密码散列。
- `npm run dashboard:build`：从模块源码生成 Dashboard 单文件包。
- `npm run deploy:check`：执行 Wrangler dry-run。

## 远程仓库与自动化边界

- GitHub 默认只用于远程版本管理、代码协作、分支、tag 和 release。
- 不得创建、恢复或提交 `.github/workflows/`、Dependabot、Renovate 或其他托管 CI/CD 自动化配置。
- 构建、测试、打包和发布验证均在本地按需手动执行。
- push、pull request、tag、release 或修改构建脚本，不代表授权启用远端自动化。
- 确需远端自动构建、测试、依赖升级或发布时，必须先取得用户明确授权。
- 保留用户已有修改；不得提交构建产物、运行数据、密钥、数据库或依赖目录。

## 编码风格与命名

使用 JavaScript ES Modules、两个空格缩进、分号和单引号。变量及函数用 `camelCase`，常量用 `UPPER_SNAKE_CASE`，文件用小写短横线。显式验证 Host、路径、环境变量和上游响应；上游地址只能来自服务端配置。不要任意修改压缩后的 JavaScript 响应正文。

## 测试规范

测试文件命名为 `*.test.js`。认证、Cookie、Host 路由、重定向、内容改写和目标校验的修改必须覆盖成功及失败路径。提交前运行 `npm test` 和 `npm run deploy:check`；修改模块源码后还应运行 `npm run dashboard:build` 并验证生成包测试。

## 提交与安全要求

使用 Conventional Commits，例如 `fix(worker): preserve vendor bundle`。合并请求需说明验证命令以及环境变量或域名变化。不得提交 `.dev.vars`、真实域名、路由表、密码、散列或会话密钥。认证响应保持 `private, no-store`，日志不得输出敏感配置。
