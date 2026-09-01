import { spawn } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createWorkerInstanceConfig,
  deriveRateLimitNamespaceId
} from './worker-instance-config.js';

const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const workerDirectory = fileURLToPath(new URL('..', import.meta.url));
const wranglerBin = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)
);

async function main() {
  const [workerName, ...extraArguments] = process.argv.slice(2);

  if (
    extraArguments.length ||
    typeof workerName !== 'string' ||
    !WORKER_NAME_PATTERN.test(workerName)
  ) {
    console.error('用法：npm run worker:create -- <worker-name>');
    process.exitCode = 1;
    return;
  }

  try {
    await access(wranglerBin);
    await ensureAuthenticated();
    await ensureWorkerDoesNotExist(workerName);
    const rateLimitNamespaceId = deriveRateLimitNamespaceId(workerName);
    const temporaryConfig = await createWorkerInstanceConfig(workerName, rateLimitNamespaceId);

    try {
      const result = await runWrangler([
        wranglerBin,
        'deploy',
        '--config',
        temporaryConfig.path,
        '--name',
        workerName,
        '--message',
        'Initialize isolated Edge App Gateway Worker'
      ]);
      writeResult(result);
      if (result.exitCode !== 0) {
        throw new Error('Cloudflare Worker 初始化失败，请检查上方 Wrangler 输出。');
      }
    } finally {
      await rm(temporaryConfig.directory, { recursive: true, force: true });
    }

    console.log('\nWorker 已创建');
    console.log(`名称：${workerName}`);
    console.log(`Rate Limiter Namespace：${rateLimitNamespaceId}`);
    console.log('公开入口：未配置（workers.dev、Preview URL 和 Custom Domain 均未启用）');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Worker 初始化失败。');
    process.exitCode = 1;
  }
}

async function ensureAuthenticated() {
  const result = await runWrangler([wranglerBin, 'whoami']);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0 || !/You are logged in/i.test(output)) {
    throw new Error('Wrangler 尚未登录，请先运行 npx wrangler login。');
  }
}

async function ensureWorkerDoesNotExist(workerName) {
  const result = await runWrangler([
    wranglerBin,
    'deployments',
    'list',
    '--name',
    workerName
  ]);
  const output = `${result.stdout}\n${result.stderr}`;

  if (result.exitCode === 0) {
    throw new Error(`Worker“${workerName}”已存在，初始化命令不会覆盖它。`);
  }
  if (!/does not exist[\s\S]*10007/i.test(output)) {
    writeResult(result);
    throw new Error('无法确认 Worker 是否已存在，请检查 Cloudflare API 或网络状态。');
  }
}

function runWrangler(argumentsList) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: workerDirectory,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', rejectPromise);
    child.once('exit', code => resolvePromise({
      exitCode: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
  });
}

function writeResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

await main();
