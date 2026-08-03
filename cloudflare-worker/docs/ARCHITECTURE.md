# 架构与能力边界

## 请求流程

```text
浏览器访问精确 Custom Domain
        ↓
Cloudflare Worker 按 Host 解析 alias
        ↓
无有效会话 → 密码验证 → 签发 alias 绑定 Cookie
        ↓
根据服务端 ROUTE_PROJECTS_JSON 构造 Vercel 上游 URL
        ↓
代理静态响应，浏览器继续停留在自定义域名
```

一个 Worker 可以绑定多个精确 Custom Domain。Cloudflare 为每个域名创建 DNS 并签发证书；不需要通配 DNS、Worker Route 或更换 Zone 的 nameserver 到 Vercel。

## 代理行为

- 浏览器侧仅允许 GET 和 HEAD 进入上游代理；其他方法返回 405。
- 请求查询参数和安全路径会传递给上游。
- 只转发有限的请求头，不把路由会话 Cookie 或客户端 Authorization 发送给 Vercel。
- 同上游重定向会改写回当前自定义 Origin。
- 响应使用 `private, no-store`，并保留必要的类型、安全、范围和缓存验证头。
- 默认不修改响应正文；显式启用 `rewriteOrigins` 时只处理声明性文本类型，不处理 JavaScript。

## 适用范围

适合：

- Vite、React、Vue 等构建出的公开静态站点；
- 使用相对资源路径的单页应用；
- 浏览器直接访问第三方 API，或只需要 GET/HEAD 同源资源的项目。

不适合：

- 需要把 POST、PUT、DELETE 等同源 API 请求继续代理到 Vercel 的应用；
- SSR、WebSocket、流式服务端功能或受 Vercel Deployment Protection 保护的上游；
- 依赖固定 `*.vercel.app` Origin、Host 或绝对资源地址的前端；
- 需要无感单点登录、细粒度用户体系或高强度在线防爆破的平台。

## 源码与部署包

`src/worker.js` 是模块入口，依赖 `src/` 和 `lib/` 中的文件。Dashboard 部署必须使用已打包的 `dashboard/worker.js`：

```bash
npm run dashboard:build
```

修改源码后应同时更新测试和单文件包。`/__route/health` 返回构建编号，可用于判断 Custom Domain 当前命中的 Production 版本。
