import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveRateLimitNamespaceId } from './worker-instance-config.js';

const CONFIG_FILE_FORMAT = 'edge-app-gateway.variables';
const CONFIG_FILE_VERSION = 1;
const MAX_CONFIG_FILE_BYTES = 2 * 1024 * 1024;
const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const workerDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryDirectory = resolve(workerDirectory, '..');

async function main() {
  const [inputPath, workerName, ...extraArguments] = process.argv.slice(2);

  if (
    extraArguments.length ||
    !inputPath ||
    !workerName ||
    !WORKER_NAME_PATTERN.test(workerName)
  ) {
    console.error('用法：npm run variables:retarget -- <variables-file> <new-worker-name>');
    process.exitCode = 1;
    return;
  }

  try {
    const sourcePath = await locatePath(inputPath);
    const fileInfo = await stat(sourcePath);
    if (!fileInfo.isFile() || fileInfo.size > MAX_CONFIG_FILE_BYTES) {
      throw new Error('源变量文件无效或超过 2 MiB。');
    }

    const parsed = JSON.parse(await readFile(sourcePath, 'utf8'));
    if (
      parsed?.format !== CONFIG_FILE_FORMAT ||
      parsed?.version !== CONFIG_FILE_VERSION ||
      !parsed.worker ||
      typeof parsed.worker !== 'object' ||
      !parsed.vars ||
      !parsed.secrets
    ) {
      throw new Error('源文件不是受支持的 Edge App Gateway 变量文件。');
    }

    const previousWorkerName = parsed.worker.name;
    if (!WORKER_NAME_PATTERN.test(String(previousWorkerName || ''))) {
      throw new Error('源变量文件中的 Worker 名称无效。');
    }
    if (previousWorkerName === workerName) {
      throw new Error('新旧 Worker 名称相同，无需生成新文件。');
    }

    const destinationPath = join(dirname(sourcePath), `${workerName}.production.variables.json`);
    if (destinationPath === sourcePath) {
      throw new Error('目标文件不能覆盖源变量文件。');
    }

    parsed.exportedAt = new Date().toISOString();
    parsed.worker.name = workerName;
    parsed.worker.rateLimitNamespaceId = deriveRateLimitNamespaceId(workerName);
    await writeFile(destinationPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });

    console.log('变量文件已安全复制并重定向');
    console.log(`原 Worker：${previousWorkerName}`);
    console.log(`新 Worker：${workerName}`);
    console.log(`Rate Limiter Namespace：${parsed.worker.rateLimitNamespaceId}`);
    console.log(`新文件：${destinationPath}`);
    console.log('源文件保持不变；未输出任何 Secret 值。');
  } catch (error) {
    const message = error?.code === 'EEXIST'
      ? '目标变量文件已存在，已拒绝覆盖。'
      : error instanceof SyntaxError
        ? '源变量文件不是有效 JSON。'
        : error instanceof Error
          ? error.message
          : '变量文件重定向失败。';
    console.error(message);
    process.exitCode = 1;
  }
}

async function locatePath(inputPath) {
  if (isAbsolute(inputPath)) return inputPath;
  const initialDirectory = process.env.INIT_CWD;
  const candidates = [
    resolve(process.cwd(), inputPath),
    initialDirectory ? resolve(initialDirectory, inputPath) : null,
    resolve(repositoryDirectory, inputPath),
    resolve(workerDirectory, inputPath)
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known invocation directory.
    }
  }
  return candidates[0];
}

await main();
