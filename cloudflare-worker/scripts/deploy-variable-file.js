import { spawn } from 'node:child_process';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getProjectHostnameAlias,
  parseRouteProjects,
  resolveUnifiedEntryAlias
} from '../lib/route-config.js';
import {
  createWorkerInstanceConfig,
  resolveRateLimitNamespaceId
} from './worker-instance-config.js';
import {
  reconcileRemoteSecrets,
  SecretReconciliationError
} from './secret-reconciliation.js';

const CONFIG_FILE_FORMAT = 'edge-app-gateway.variables';
const CONFIG_FILE_VERSION = 1;
const MAX_CONFIG_FILE_BYTES = 2 * 1024 * 1024;
const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const BINDING_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const ALLOWED_VARIABLES = new Set([
  'ROUTE_BASE_DOMAIN',
  'ROUTE_SESSION_TTL_SECONDS'
]);
const workerDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryDirectory = resolve(workerDirectory, '..');
const wranglerBin = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)
);

async function main() {
  const parsedArguments = parseArguments(process.argv.slice(2));
  if (!parsedArguments) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const { checkOnly, configFile, dryRun, requestedWorkerName } = parsedArguments;

  let secretValues = [];

  try {
    const configPath = await locateConfigPath(configFile);
    const fileInfo = await readConfigFileInfo(configPath);
    let parsed;

    try {
      parsed = JSON.parse(await readFile(configPath, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new CliError('INVALID_JSON', '变量文件不是有效 JSON。');
      }
      throw error;
    }

    secretValues = Object.values(parsed?.secrets || {})
      .filter(value => typeof value === 'string' && value.length > 0);
    const config = validateVariablesFile(parsed);
    if (config.workerName !== requestedWorkerName) {
      throw new CliError(
        'WORKER_MISMATCH',
        `命令指定的 Worker“${requestedWorkerName}”与变量文件中的“${config.workerName}”不一致。`
      );
    }
    printSummary(config, checkOnly ? '校验通过' : dryRun ? '准备 dry-run' : '准备部署');

    if (checkOnly) return;

    await ensureWranglerInstalled();
    if (!dryRun) {
      printSecurityNotice(configPath, fileInfo.mode);
      await ensureWranglerAuthenticated(config.secretValues);
    }

    const result = await runWrangler(config, { configPath, dryRun });
    writeWranglerOutput(result, config.secretValues);

    if (result.exitCode !== 0) {
      throw classifyWranglerFailure(`${result.stdout}\n${result.stderr}`);
    }

    if (!dryRun) {
      let reconciliation;
      try {
        reconciliation = await reconcileRemoteSecrets({
          desiredSecretNames: config.secretNames,
          runCommand: (argumentsList, input) => runProcess(
            [wranglerBin, ...argumentsList],
            input
          ),
          workerName: config.workerName
        });
      } catch (error) {
        if (error instanceof SecretReconciliationError) {
          throw new CliError(
            'SECRET_RECONCILIATION_FAILED',
            [
              'Worker 新版本已部署，但远端 Secret 未能完全收敛。',
              safeMessage(error),
              '请检查 Cloudflare API 状态后重新运行同一正式部署命令。'
            ].join('\n')
          );
        }
        throw error;
      }
      const deployedVersionId = extractVersionId(`${result.stdout}\n${result.stderr}`);
      const activeVersionId = reconciliation.deleted.length
        ? await readLatestActiveVersionId(config.workerName)
        : deployedVersionId;
      printDeploymentResult(config, {
        activeVersionId,
        deployedVersionId,
        reconciliation
      });
    }
  } catch (error) {
    console.error(formatCliError(error, secretValues));
    process.exitCode = 1;
  }
}

function parseArguments(argumentsList) {
  let checkOnly = false;
  let configFile = null;
  let dryRun = false;
  let requestedWorkerName = null;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];

    if (argument === '--check') {
      if (checkOnly) return null;
      checkOnly = true;
    } else if (argument === '--dry-run') {
      if (dryRun) return null;
      dryRun = true;
    } else if (argument === '--worker') {
      const value = argumentsList[index + 1];
      if (requestedWorkerName || !value || value.startsWith('--')) return null;
      requestedWorkerName = value;
      index += 1;
    } else if (argument.startsWith('--') || configFile) {
      return null;
    } else {
      configFile = argument;
    }
  }

  if (
    !configFile ||
    checkOnly && dryRun ||
    !requestedWorkerName ||
    !WORKER_NAME_PATTERN.test(requestedWorkerName)
  ) {
    return null;
  }
  return { checkOnly, configFile, dryRun, requestedWorkerName };
}

async function locateConfigPath(inputPath) {
  if (isAbsolute(inputPath)) return inputPath;

  const initialDirectory = process.env.INIT_CWD;
  const candidates = [
    resolve(process.cwd(), inputPath),
    initialDirectory ? resolve(initialDirectory, inputPath) : null,
    resolve(repositoryDirectory, inputPath),
    resolve(workerDirectory, inputPath)
  ].filter(Boolean);
  const uniqueCandidates = [...new Set(candidates)];

  for (const candidate of uniqueCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known invocation directory.
    }
  }

  return uniqueCandidates[0];
}

async function readConfigFileInfo(configPath) {
  let fileInfo;

  try {
    fileInfo = await stat(configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CliError(
        'FILE_NOT_FOUND',
        [
          `找不到变量文件：${configPath}`,
          repairCommandGuide(basename(configPath))
        ].join('\n')
      );
    }
    throw error;
  }

  if (!fileInfo.isFile()) {
    throw new CliError('INVALID_FILE', `变量文件不是普通文件：${configPath}`);
  }
  if (fileInfo.size > MAX_CONFIG_FILE_BYTES) {
    throw new CliError('INVALID_FILE', `变量文件超过 2 MiB：${configPath}`);
  }
  return fileInfo;
}

function validateVariablesFile(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new CliError('INVALID_CONFIG', '变量文件顶层必须是对象。');
  }

  if (value.format !== CONFIG_FILE_FORMAT || value.version !== CONFIG_FILE_VERSION) {
    throw new CliError(
      'INVALID_CONFIG',
      `仅支持 ${CONFIG_FILE_FORMAT} v${CONFIG_FILE_VERSION}。`
    );
  }

  const workerName = value.worker?.name;
  if (typeof workerName !== 'string' || !WORKER_NAME_PATTERN.test(workerName)) {
    throw new CliError('INVALID_CONFIG', 'Worker 名称无效。');
  }
  const rateLimitNamespaceId = validateRateLimitNamespaceId(
    value.worker?.rateLimitNamespaceId,
    workerName
  );

  const vars = value.vars;
  if (!vars || Array.isArray(vars) || typeof vars !== 'object') {
    throw new CliError('INVALID_CONFIG', 'vars 必须是对象。');
  }

  const variableEntries = Object.entries(vars);
  if (
    variableEntries.length < 2 ||
    variableEntries.length !== ALLOWED_VARIABLES.size ||
    variableEntries.some(([name, variableValue]) => (
      !ALLOWED_VARIABLES.has(name) || typeof variableValue !== 'string'
    )) ||
    typeof vars.ROUTE_BASE_DOMAIN !== 'string' ||
    typeof vars.ROUTE_SESSION_TTL_SECONDS !== 'string'
  ) {
    throw new CliError(
      'INVALID_CONFIG',
      'vars 必须只包含 ROUTE_BASE_DOMAIN 和 ROUTE_SESSION_TTL_SECONDS 字符串。'
    );
  }

  const baseDomain = validateBaseDomain(vars.ROUTE_BASE_DOMAIN);
  const ttlSeconds = Number(vars.ROUTE_SESSION_TTL_SECONDS);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 604800) {
    throw new CliError('INVALID_CONFIG', 'ROUTE_SESSION_TTL_SECONDS 无效。');
  }

  const secrets = value.secrets;
  if (!secrets || Array.isArray(secrets) || typeof secrets !== 'object') {
    throw new CliError('SECRET_MISSING', '变量文件缺少 secrets 对象。');
  }
  if (typeof secrets.ROUTE_PROJECTS_JSON !== 'string' || !secrets.ROUTE_PROJECTS_JSON) {
    throw new CliError('SECRET_MISSING', '缺少 ROUTE_PROJECTS_JSON Secret。');
  }

  for (const [name, secret] of Object.entries(secrets)) {
    if (!BINDING_NAME_PATTERN.test(name) || typeof secret !== 'string') {
      throw new CliError('INVALID_CONFIG', `Secret Binding“${name}”无效。`);
    }
  }

  let projects;
  try {
    projects = parseRouteProjects(secrets.ROUTE_PROJECTS_JSON);
  } catch (error) {
    throw new CliError('INVALID_CONFIG', safeMessage(error));
  }

  let needsSessionSecret = false;
  const originBindingOwners = new Map();

  for (const [alias, project] of projects) {
    if (project.edgeAccess.mode === 'required' || project.entryAccess.mode === 'required') {
      needsSessionSecret = true;
    }
    if (project.originProtection.mode === 'required') {
      const secretBinding = project.originProtection.secretBinding;
      const existingOwner = originBindingOwners.get(secretBinding);
      if (existingOwner) {
        throw new CliError(
          'INVALID_CONFIG',
          `应用“${alias}”与“${existingOwner}”不能共用 Origin Secret Binding。`
        );
      }
      originBindingOwners.set(secretBinding, alias);
      const originSecret = secrets[secretBinding];
      if (typeof originSecret !== 'string' || originSecret.length < 16) {
        throw new CliError('SECRET_MISSING', `应用“${alias}”缺少有效的 ${secretBinding} Secret。`);
      }
    }
  }

  if (needsSessionSecret && String(secrets.ROUTE_SESSION_SECRET || '').length < 32) {
    throw new CliError(
      'SECRET_MISSING',
      '启用 Edge Access 或统一入口通行时必须提供有效的 ROUTE_SESSION_SECRET。'
    );
  }

  let entryAlias;
  try {
    entryAlias = resolveUnifiedEntryAlias(projects);
  } catch (error) {
    throw new CliError('INVALID_CONFIG', safeMessage(error));
  }

  const expectedDomains = [...projects]
    .map(([semanticAlias, project]) => {
      const hostnameAlias = getProjectHostnameAlias(semanticAlias, project);
      return hostnameAlias ? `${hostnameAlias}.${baseDomain}` : baseDomain;
    })
    .sort();
  const healthDomains = [...projects]
    .filter(([, project]) => project.entryAccess.mode !== 'required')
    .map(([semanticAlias, project]) => {
      const hostnameAlias = getProjectHostnameAlias(semanticAlias, project);
      return hostnameAlias ? `${hostnameAlias}.${baseDomain}` : baseDomain;
    })
    .sort();
  const customDomains = value.worker?.customDomains;
  if (
    !Array.isArray(customDomains) ||
    customDomains.some(domain => typeof domain !== 'string') ||
    JSON.stringify([...customDomains].sort()) !== JSON.stringify(expectedDomains)
  ) {
    throw new CliError(
      'INVALID_CONFIG',
      'Custom Domains 与 Alias/ROUTE_BASE_DOMAIN 不一致。'
    );
  }

  return {
    workerName,
    rateLimitNamespaceId,
    vars,
    entryAlias,
    secrets,
    customDomains: expectedDomains,
    healthDomains,
    projectCount: projects.size,
    secretNames: Object.keys(secrets),
    secretValues: Object.values(secrets).filter(value => typeof value === 'string' && value)
  };
}

function validateRateLimitNamespaceId(value, workerName) {
  try {
    return resolveRateLimitNamespaceId(value, workerName);
  } catch (error) {
    throw new CliError(
      'INVALID_CONFIG',
      `worker.rateLimitNamespaceId 无效：${safeMessage(error)}`
    );
  }
}

function validateBaseDomain(value) {
  if (
    typeof value !== 'string' ||
    !value.includes('.') ||
    value.includes('://') ||
    value.includes('/') ||
    value.includes('*') ||
    value.includes(':') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.includes('..') ||
    !/^[a-z0-9.-]+$/.test(value)
  ) {
    throw new CliError('INVALID_CONFIG', 'ROUTE_BASE_DOMAIN 无效。');
  }
  return value;
}

async function ensureWranglerInstalled() {
  try {
    await access(wranglerBin);
  } catch {
    throw new CliError(
      'DEPENDENCIES_MISSING',
      '尚未安装 cloudflare-worker 依赖。请先运行：\nnpm --prefix cloudflare-worker install'
    );
  }
}

async function ensureWranglerAuthenticated(secretValues) {
  const result = await runProcess([wranglerBin, 'whoami']);
  const output = redactSecrets(`${result.stdout}\n${result.stderr}`, secretValues);
  const unauthenticated = /not authenticated|wrangler login|CLOUDFLARE_API_TOKEN/i.test(output);

  if (unauthenticated) {
    throw new CliError(
      'WRANGLER_NOT_AUTHENTICATED',
      [
        'Wrangler 尚未登录，请运行：',
        'cd cloudflare-worker',
        'npx wrangler whoami',
        'npx wrangler login'
      ].join('\n')
    );
  }

  if (result.exitCode !== 0) {
    throw new CliError('CLOUDFLARE_API_FAILED', 'Wrangler 账号检查失败，请检查网络或 Cloudflare API 状态。');
  }

  if (!/You are logged in/i.test(output)) {
    throw new CliError(
      'WRANGLER_NOT_AUTHENTICATED',
      '无法确认 Wrangler 登录状态。请运行：\ncd cloudflare-worker\nnpx wrangler whoami\nnpx wrangler login'
    );
  }
}

async function runWrangler(config, { configPath, dryRun }) {
  const temporaryConfig = await createWorkerInstanceConfig(
    config.workerName,
    config.rateLimitNamespaceId
  );

  try {
    const wranglerArguments = [
      wranglerBin,
      'deploy',
      '--config',
      temporaryConfig.path,
      '--name',
      config.workerName,
      ...Object.entries(config.vars).flatMap(([name, value]) => ['--var', `${name}:${value}`]),
      ...config.customDomains.flatMap(domain => ['--domain', domain]),
      '--secrets-file',
      '/dev/stdin',
      '--message',
      `Deploy from ${basename(configPath)}`
    ];

    if (dryRun) wranglerArguments.push('--dry-run');
    return await runProcess(wranglerArguments, JSON.stringify(config.secrets));
  } finally {
    await rm(temporaryConfig.directory, { recursive: true, force: true });
  }
}

function runProcess(argumentsList, input = '') {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: workerDirectory,
      stdio: ['pipe', 'pipe', 'pipe']
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
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') rejectPromise(error);
    });
    child.stdin.end(input);
  });
}

function writeWranglerOutput(result, secretValues) {
  const stdout = redactSecrets(result.stdout, secretValues);
  const stderr = redactSecrets(result.stderr, secretValues);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function classifyWranglerFailure(output) {
  if (/not authenticated|wrangler login|CLOUDFLARE_API_TOKEN/i.test(output)) {
    return new CliError(
      'WRANGLER_NOT_AUTHENTICATED',
      'Wrangler 登录已失效。请运行：\ncd cloudflare-worker\nnpx wrangler whoami\nnpx wrangler login'
    );
  }
  if (/(?:custom domain|domain)[^\n]*(?:already|conflict|another worker|not available|bound|owned)|zone[^\n]*not found/i.test(output)) {
    return new CliError(
      'CUSTOM_DOMAIN_CONFLICT',
      'Custom Domain 绑定失败，请检查域名是否已绑定到其他 Worker，以及当前账号是否拥有对应 Zone。'
    );
  }
  return new CliError(
    'CLOUDFLARE_API_FAILED',
    'Cloudflare API 部署失败，请根据上方 Wrangler 输出检查权限、网络或平台状态。'
  );
}

function printSummary(config, action) {
  console.log(`${action}：Worker ${config.workerName}`);
  console.log(`应用数量：${config.projectCount}`);
  console.log(`Rate Limiter Namespace：${config.rateLimitNamespaceId}`);
  console.log(`Custom Domains：${config.customDomains.join(', ')}`);
  console.log(`Secret Bindings：${config.secretNames.join(', ')}`);
}

function printSecurityNotice(configPath, mode) {
  console.log('安全提醒：变量文件包含生产 Secret，正式部署后仍需妥善保管。');
  const privatePermissions = (mode & 0o077) === 0;
  if (privatePermissions) {
    console.log('文件权限：当前权限已限制为仅所有者访问。');
  } else {
    console.log(`文件权限建议：chmod 600 ${shellQuote(configPath)}`);
  }
}

function printDeploymentResult(config, { activeVersionId, deployedVersionId, reconciliation }) {
  console.log('\n部署完成');
  console.log(`Worker 名称：${config.workerName}`);
  console.log(`代码部署 Version ID：${deployedVersionId || '未能从 Wrangler 输出解析'}`);
  if (reconciliation.deleted.length) {
    console.log(`最终活动 Version ID：${activeVersionId || '未能从 Cloudflare 确认'}`);
  }
  console.log(`Custom Domains：${config.customDomains.join(', ')}`);
  console.log(`Secret Bindings：${config.secretNames.join(', ')}`);
  console.log(reconciliation.deleted.length
    ? `已删除残留 Secret：${reconciliation.deleted.join(', ')}`
    : 'Secret 收敛：远端没有残留 Binding。');
  console.log('公开健康检查命令：');
  for (const domain of config.healthDomains) {
    console.log(`curl -fsS ${shellQuote(`https://${domain}/_edge-gateway/health`)}`);
  }
}

function extractVersionId(output) {
  return output.match(/Current Version ID:\s*([a-f0-9-]+)/i)?.[1] || null;
}

async function readLatestActiveVersionId(workerName) {
  const result = await runProcess([
    wranglerBin,
    'deployments',
    'list',
    '--name',
    workerName,
    '--json'
  ]);
  if (result.exitCode !== 0) return null;

  try {
    const deployments = JSON.parse(result.stdout);
    if (!Array.isArray(deployments) || !deployments.length) return null;
    const versions = deployments.at(-1)?.versions;
    if (!Array.isArray(versions)) return null;
    const activeVersion = versions.find(version => version?.percentage === 100);
    const versionId = activeVersion?.version_id;
    return typeof versionId === 'string' && /^[a-f0-9-]+$/i.test(versionId)
      ? versionId
      : null;
  } catch {
    return null;
  }
}

function formatCliError(error, secretValues) {
  const code = error instanceof CliError ? error.code : 'UNKNOWN';
  const labels = {
    FILE_NOT_FOUND: '文件不存在',
    INVALID_FILE: '文件无效',
    INVALID_JSON: 'JSON 无效',
    INVALID_CONFIG: '配置校验失败',
    SECRET_MISSING: 'Secret 缺失',
    WORKER_MISMATCH: 'Worker 不匹配',
    SECRET_RECONCILIATION_FAILED: 'Secret 收敛失败',
    DEPENDENCIES_MISSING: '依赖未安装',
    WRANGLER_NOT_AUTHENTICATED: 'Wrangler 未登录',
    CUSTOM_DOMAIN_CONFLICT: 'Custom Domain 冲突',
    CLOUDFLARE_API_FAILED: 'Cloudflare API 失败',
    UNKNOWN: '部署工具错误'
  };
  return `[${labels[code]}] ${redactSecrets(safeMessage(error), secretValues)}`;
}

function safeMessage(error) {
  return error instanceof Error ? error.message : '未知错误。';
}

function redactSecrets(value, secretValues) {
  let redacted = String(value || '');
  const orderedSecrets = [...new Set(secretValues)]
    .filter(secret => typeof secret === 'string' && secret)
    .sort((left, right) => right.length - left.length);
  for (const secret of orderedSecrets) redacted = redacted.replaceAll(secret, '[REDACTED]');
  return redacted;
}

function repairCommandGuide(fileName) {
  const safeFileName = fileName || 'lx-cm-route.production.variables.json';
  return [
    `当前工作目录：${process.env.INIT_CWD || process.cwd()}`,
    `请先进入仓库根目录：${repositoryDirectory}`,
    '然后运行：',
    rootDeployCommand(safeFileName, '<worker-name>', '--check')
  ].join('\n');
}

function rootDeployCommand(fileName, workerName, option = '') {
  const command = [
    'npm --prefix cloudflare-worker run deploy:config --',
    shellQuote(`../${fileName}`),
    '--worker',
    shellQuote(workerName),
    option
  ].filter(Boolean);
  return command.join(' ');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function printUsage() {
  console.error([
    '参数错误：必须提供一个变量文件，并且 --check 与 --dry-run 不能同时使用。',
    `请先进入仓库根目录：${repositoryDirectory}`,
    '推荐命令：',
    rootDeployCommand('lx-cm-route.production.variables.json', 'lx-cm-route', '--check'),
    rootDeployCommand('lx-cm-route.production.variables.json', 'lx-cm-route', '--dry-run'),
    rootDeployCommand('lx-cm-route.production.variables.json', 'lx-cm-route')
  ].join('\n'));
}

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

await main();
