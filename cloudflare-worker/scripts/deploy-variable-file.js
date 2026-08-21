import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRouteProjects } from '../lib/route-config.js';

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
const wranglerBin = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)
);

const argumentsList = process.argv.slice(2);
const dryRun = argumentsList.includes('--dry-run');
const checkOnly = argumentsList.includes('--check');
const unknownOptions = argumentsList.filter(argument => argument.startsWith('--'))
  .filter(argument => !['--dry-run', '--check'].includes(argument));
const fileArguments = argumentsList.filter(argument => !argument.startsWith('--'));

if (unknownOptions.length || fileArguments.length !== 1 || (dryRun && checkOnly)) {
  printUsage();
  process.exitCode = 1;
} else {
  try {
    const configPath = resolve(fileArguments[0]);
    const fileInfo = await stat(configPath);

    if (!fileInfo.isFile() || fileInfo.size > MAX_CONFIG_FILE_BYTES) {
      throw new Error('变量文件必须是大小不超过 2 MiB 的普通文件。');
    }

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    const config = validateVariablesFile(parsed);
    printSummary(config, checkOnly ? '校验通过' : dryRun ? '准备 dry-run' : '准备部署');

    if (!checkOnly) {
      const exitCode = await runWrangler(config, { configPath, dryRun });
      if (exitCode !== 0) process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(`变量文件处理失败：${safeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

function validateVariablesFile(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('顶层必须是对象。');
  }

  if (value.format !== CONFIG_FILE_FORMAT || value.version !== CONFIG_FILE_VERSION) {
    throw new Error(`仅支持 ${CONFIG_FILE_FORMAT} v${CONFIG_FILE_VERSION}。`);
  }

  const workerName = value.worker?.name;
  if (typeof workerName !== 'string' || !WORKER_NAME_PATTERN.test(workerName)) {
    throw new Error('Worker 名称无效。');
  }

  const vars = value.vars;
  if (!vars || Array.isArray(vars) || typeof vars !== 'object') {
    throw new Error('vars 必须是对象。');
  }

  const variableEntries = Object.entries(vars);
  if (
    variableEntries.length !== ALLOWED_VARIABLES.size ||
    variableEntries.some(([name, variableValue]) => (
      !ALLOWED_VARIABLES.has(name) || typeof variableValue !== 'string'
    ))
  ) {
    throw new Error('vars 只能包含 ROUTE_BASE_DOMAIN 和 ROUTE_SESSION_TTL_SECONDS 字符串。');
  }

  const baseDomain = validateBaseDomain(vars.ROUTE_BASE_DOMAIN);
  const ttlSeconds = Number(vars.ROUTE_SESSION_TTL_SECONDS);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 604800) {
    throw new Error('ROUTE_SESSION_TTL_SECONDS 无效。');
  }

  const secrets = value.secrets;
  if (!secrets || Array.isArray(secrets) || typeof secrets !== 'object') {
    throw new Error('secrets 必须是对象。');
  }

  for (const [name, secret] of Object.entries(secrets)) {
    if (!BINDING_NAME_PATTERN.test(name) || typeof secret !== 'string') {
      throw new Error(`Secret Binding“${name}”无效。`);
    }
  }

  const projects = parseRouteProjects(secrets.ROUTE_PROJECTS_JSON);
  let needsSessionSecret = false;
  const originBindingOwners = new Map();

  for (const [alias, project] of projects) {
    if (project.edgeAccess.mode === 'required') needsSessionSecret = true;
    if (project.originProtection.mode === 'required') {
      const secretBinding = project.originProtection.secretBinding;
      const existingOwner = originBindingOwners.get(secretBinding);
      if (existingOwner) {
        throw new Error(`应用“${alias}”与“${existingOwner}”不能共用 Origin Secret Binding。`);
      }
      originBindingOwners.set(secretBinding, alias);
      const originSecret = secrets[secretBinding];
      if (typeof originSecret !== 'string' || originSecret.length < 16) {
        throw new Error(`应用“${alias}”缺少有效的 Origin Secret。`);
      }
    }
  }

  if (needsSessionSecret && String(secrets.ROUTE_SESSION_SECRET || '').length < 32) {
    throw new Error('启用 Edge Access 时必须提供有效的 ROUTE_SESSION_SECRET。');
  }

  const expectedDomains = [...projects.keys()].map(alias => `${alias}.${baseDomain}`).sort();
  const customDomains = value.worker?.customDomains;
  if (
    !Array.isArray(customDomains) ||
    customDomains.some(domain => typeof domain !== 'string') ||
    JSON.stringify([...customDomains].sort()) !== JSON.stringify(expectedDomains)
  ) {
    throw new Error('Custom Domains 与 Alias/ROUTE_BASE_DOMAIN 不一致。');
  }

  return {
    workerName,
    vars,
    secrets,
    customDomains: expectedDomains,
    projectCount: projects.size,
    secretNames: Object.keys(secrets)
  };
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
    throw new Error('ROUTE_BASE_DOMAIN 无效。');
  }
  return value;
}

function runWrangler(config, { configPath, dryRun }) {
  const wranglerArguments = [
    wranglerBin,
    'deploy',
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

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, wranglerArguments, {
      cwd: workerDirectory,
      stdio: ['pipe', 'inherit', 'inherit']
    });

    child.once('error', rejectPromise);
    child.once('exit', code => resolvePromise(code ?? 1));
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') rejectPromise(error);
    });
    child.stdin.end(JSON.stringify(config.secrets));
  });
}

function printSummary(config, action) {
  console.log(`${action}：Worker ${config.workerName}`);
  console.log(`应用数量：${config.projectCount}`);
  console.log(`Custom Domains：${config.customDomains.join(', ')}`);
  console.log(`Secret Bindings：${config.secretNames.join(', ')}`);
}

function safeErrorMessage(error) {
  if (error instanceof SyntaxError) return 'JSON 格式无效。';
  return error instanceof Error ? error.message : '未知错误。';
}

function printUsage() {
  console.error('用法：npm run deploy:config -- <variables.json> [--check | --dry-run]');
}
