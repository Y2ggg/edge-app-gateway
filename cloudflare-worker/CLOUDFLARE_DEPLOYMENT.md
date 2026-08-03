# Cloudflare Worker 部署手册

本文对应已验证的最终方案：普通 Worker、多个精确 Custom Domain、每项目独立密码。示例使用 `demo.example.com` 作为路由基础域，实际部署时替换为自己的域名。

## 1. 部署前确认

- 域名所在 Zone 已托管在 Cloudflare。
- 每个上游是公开可访问的 `https://*.vercel.app` 静态项目。
- Vercel Deployment Protection 未阻止 Worker 访问。
- 不创建通配 Custom Domain、通配 DNS 或 Worker Route。
- 不选择 Pages、Static Assets、React Router 模板或 Workers for Platforms。

最终访问结构示例：

```text
license.demo.example.com → license-project.vercel.app
docs.demo.example.com    → docs-project.vercel.app
```

## 2. 生成密钥和项目散列

推荐直接双击打开 [`tools/config-generator.html`](./tools/config-generator.html)。该页面完全离线运行，不会发送配置或密码。

1. 点击“生成会话密钥”，保存 `ROUTE_SESSION_SECRET`。
2. 为每个项目输入独立的强密码。
3. 确认页面中的会话密钥与第 1 步一致。
4. 生成并保存对应的 `hmac-sha256$...` 散列。
5. 使用“验证现有配置”检查域名、路由表、密码和密钥是否匹配。

也可以使用命令行：

```bash
npm run session:secret
npm run password:hash -- "项目访问密码" "ROUTE_SESSION_SECRET"
```

散列与会话密钥绑定。更换 `ROUTE_SESSION_SECRET` 时，所有项目散列都必须重新生成，现有登录会话也会失效。不要继续使用旧的 `pbkdf2$...` 或 Vercel `scrypt$...` 散列。

## 3. 创建普通 Worker

1. 进入 Cloudflare **Workers & Pages → Create application → Create Worker**。
2. 选择 Hello World 或 Start from scratch 并完成首次部署。
3. 打开 **Edit code**，删除模板代码。
4. 将 [`dashboard/worker.js`](./dashboard/worker.js) 的全部内容粘贴进去。
5. 点击 **Deploy**，确认该版本进入 Production。

Dashboard 单文件不能与 `src/worker.js` 混用；后者包含跨文件 import，不能直接粘贴。

## 4. 配置变量和路由表

进入 **Settings → Variables and Secrets**，添加：

```dotenv
ROUTE_BASE_DOMAIN=demo.example.com
ROUTE_PROJECTS_JSON={"license":{"target":"https://license-project.vercel.app","passwordHash":"hmac-sha256$...","rewriteOrigins":false},"docs":{"target":"https://docs-project.vercel.app","passwordHash":"hmac-sha256$...","rewriteOrigins":false}}
ROUTE_SESSION_SECRET=本地生成的会话密钥
ROUTE_SESSION_TTL_SECONDS=28800
```

变量类型：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `ROUTE_PROJECTS_JSON` | Secret | 完整项目路由表 |
| `ROUTE_SESSION_SECRET` | Secret | 密码 pepper 和会话签名密钥 |
| `ROUTE_BASE_DOMAIN` | Text | 多项目域名的公共后缀，不含协议和通配符 |
| `ROUTE_SESSION_TTL_SECONDS` | Text | 可选，会话时长，默认 `28800` |

JSON 键必须等于域名前缀：`license.demo.example.com` 对应 `license`。Alias 只能使用 3–63 位小写字母、数字和短横线。`target` 不得包含账号密码、查询参数或片段。

Secret 保存后无法从 Dashboard 重新查看。请在安全位置保留路由表副本；新增项目时必须提交包含所有旧项目的完整 JSON。

## 5. 添加精确 Custom Domain

对每个项目分别操作：

1. 打开 Worker **Settings → Domains & Routes**。
2. 选择 **Add → Custom Domain**，不要选择 Route。
3. 输入完整域名，例如 `license.demo.example.com`。
4. 等待状态变为 **Active**。

Cloudflare 会自动创建该精确域名的 DNS 记录并签发 HTTPS 证书。如果域名已有 DNS 记录，先确认它没有被其他业务使用，再处理冲突。不要填写 `*.demo.example.com`。

## 6. 验证上线

访问任一已绑定域名：

```text
https://license.demo.example.com/__route/health
```

当前版本应返回：

```json
{"ok":true,"build":"2026-08-03-route-v2","edge":"HKG"}
```

然后验证：

1. 根路径进入密码页面。
2. 错误密码、未知项目和不可用上游均只显示“无法访问”。
3. 正确密码显示进入动画并加载项目。
4. Network 中资源继续使用当前自定义域名。
5. Console 没有项目自身的生产构建错误。

## 7. 新增项目

以 `admin.demo.example.com` 为例：

1. 使用当前 `ROUTE_SESSION_SECRET` 为 admin 密码生成新散列。
2. 在本地保存的完整 `ROUTE_PROJECTS_JSON` 中加入：

```json
"admin": {
  "target": "https://admin-project.vercel.app",
  "passwordHash": "hmac-sha256$...",
  "rewriteOrigins": false
}
```

3. 用完整 JSON 替换 Dashboard 中的 Secret 并部署到 Production。
4. 为同一 Worker 添加精确 Custom Domain `admin.demo.example.com`。
5. 等待 Active，依次验证健康接口、错误密码和正确密码。

## 8. 更新与回滚

代码更新时重新粘贴最新 `dashboard/worker.js` 并 Deploy。先通过健康接口核对 `build`，再测试登录。Cloudflare Deployments 可以回滚 Worker 代码版本；Custom Domain、DNS 和变量属于外部状态，不会随代码自动回滚。

遇到认证、证书、白屏或版本问题时，参阅[故障排查](./docs/TROUBLESHOOTING.md)。完整字段约束和密钥轮换规则见[配置与安全](./docs/CONFIGURATION.md)。
