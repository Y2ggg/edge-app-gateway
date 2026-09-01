import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const wranglerConfigPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const workerEntryPath = fileURLToPath(new URL('../src/worker.js', import.meta.url));

export function resolveRateLimitNamespaceId(value, workerName) {
  const namespaceId = value === undefined || value === ''
    ? deriveRateLimitNamespaceId(workerName)
    : String(value);

  if (!/^[1-9][0-9]{0,9}$/.test(namespaceId) || Number(namespaceId) > 2147483647) {
    throw new Error('Rate Limiter Namespace ID 必须是 1–2147483647 的整数字符串。');
  }
  return namespaceId;
}

export function deriveRateLimitNamespaceId(workerName) {
  if (workerName === 'lx-cm-route') return '1001';

  let hash = 2166136261;
  for (let index = 0; index < workerName.length; index += 1) {
    hash ^= workerName.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return String(10000 + (hash >>> 0) % 2000000000);
}

export async function createWorkerInstanceConfig(workerName, rateLimitNamespaceId) {
  let baseConfig;

  try {
    baseConfig = JSON.parse(await readFile(wranglerConfigPath, 'utf8'));
  } catch {
    throw new Error('wrangler.jsonc 必须保持为可直接解析的 JSON，才能生成实例隔离配置。');
  }

  if (
    !Array.isArray(baseConfig.ratelimits) ||
    baseConfig.ratelimits.length !== 1 ||
    baseConfig.ratelimits[0]?.name !== 'EDGE_LOGIN_RATE_LIMITER'
  ) {
    throw new Error('wrangler.jsonc 缺少标准登录限流 Binding。');
  }

  delete baseConfig.$schema;
  baseConfig.name = workerName;
  baseConfig.main = workerEntryPath;
  baseConfig.ratelimits = [{
    ...baseConfig.ratelimits[0],
    namespace_id: rateLimitNamespaceId
  }];

  const directory = await mkdtemp(join(tmpdir(), 'edge-app-gateway-wrangler-'));
  const path = join(directory, 'wrangler.json');
  try {
    await writeFile(path, `${JSON.stringify(baseConfig, null, 2)}\n`, { mode: 0o600 });
    return { directory, path };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
