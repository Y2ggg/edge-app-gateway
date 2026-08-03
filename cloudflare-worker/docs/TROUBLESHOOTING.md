# 故障排查

先访问当前域名的健康接口：

```text
https://项目域名/__route/health
```

预期包含 `"build":"2026-08-03-gateway-v3"`。构建编号不符时，先确认 Edit code 已 Deploy、最新 Deployment 承担 Production 流量，并确认 Custom Domain 绑定的是同一个 Worker。

## 域名和 HTTPS

| 现象 | 检查 |
| --- | --- |
| `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` | 必须添加精确 Custom Domain，等待状态 Active；不要使用通配 Custom Domain |
| 提示修改为 Vercel nameserver | 当前操作位置不对；域名应绑定到 Cloudflare Worker，而不是 Vercel DNS |
| 正确和错误子域行为相同 | 核对 `ROUTE_BASE_DOMAIN`、JSON alias 和实际 Custom Domain |
| 修改代码或变量后无变化 | 在 Deployments 中确认最新版本已进入 Production，并检查健康接口 build |

## 密码始终失败

1. 确认散列以 `hmac-sha256$` 开头，而不是旧的 `pbkdf2$` 或 `scrypt$`。
2. 确认生成散列和线上验证使用同一个 `ROUTE_SESSION_SECRET`。
3. 使用离线 [`../tools/config-generator.html`](../tools/config-generator.html) 检查完整域名、基础域、路由表、明文密码和密钥。
4. 查看 **Observability → Logs → Live logs**，但不要复制敏感配置。

旧版出现 `pbkdf2-derive: NotSupportedError` 时，说明仍在运行 PBKDF2 版本；部署最新单文件包并重新生成 HMAC 散列。正常表单 Origin 应等于当前 HTTPS Origin。若日志为 `origin-mismatch`，检查是否仍有旧验证页发送 `Origin: null`。

日志可能记录以下非敏感原因码：

- `origin-mismatch`
- `route-not-resolved`
- `project-not-found`
- `password-mismatch`

浏览器对这些情况始终只显示“无法访问”。

## 验证通过但项目无法加载

- 上游返回 401/404：关闭 Vercel Deployment Protection，并确认 target 指向公开 Production 部署。
- JS 请求返回 HTML：目标资源不存在或被上游重写到 SPA 页面；检查 Vercel 构建输出和路由。
- 同源 POST/API 返回 405：本 Worker 只代理静态 GET/HEAD；API 需要改为浏览器直连独立地址或扩展服务端代理设计。
- 控制台只有 Cloudflare Insights CSP 警告：通常不影响项目，可关闭 Web Analytics/Browser Insights 后复测。

## 所有资源 200 但页面白屏

若 `rewriteOrigins` 已为 `false`，JS 状态为 200、类型为 JavaScript，且错误位于 `vendor-*.js` 内部，优先诊断上游项目的生产构建，而不是路由 Worker：

```bash
npm run build
npm run preview
```

本地 `npm run dev` 正常不能证明生产 bundle 正常。重点检查 Vite/Rolldown 的 `manualChunks`、vendor 分包插件、CommonJS 循环依赖，以及 Vercel 与本地的 Node、包管理器、锁文件和 Build Command 是否一致。清除 Vercel Build Cache 后重新部署，并避免直接修改压缩后的 vendor 文件。

## 本地维护检查

```bash
npm run dashboard:build
npm test
npm run test:coverage
npm run deploy:check
```

测试失败时先修复源码或测试，不要手工编辑 `dashboard/worker.js` 来绕过差异。
