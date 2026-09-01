import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const deployScript = fileURLToPath(new URL('../scripts/deploy-variable-file.js', import.meta.url));
const retargetScript = fileURLToPath(
  new URL('../scripts/retarget-variables-file.js', import.meta.url)
);
const workerDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryDirectory = resolve(workerDirectory, '..');
const deployScriptSource = await readFile(deployScript, 'utf8');

function deployArguments(configPath, option, workerName = 'lx-cm-route') {
  return [deployScript, configPath, '--worker', workerName, option].filter(Boolean);
}

function createVariablesFile() {
  const projects = {
    portal: {
      target: 'https://portal-app.vercel.app',
      deliveryMode: 'proxy',
      proxyProfile: 'fullstack',
      requestOriginPolicy: 'rewrite-to-upstream',
      edgeAccess: { mode: 'disabled' },
      originProtection: {
        mode: 'required',
        headerName: 'x-edge-app-gateway-origin',
        secretBinding: 'ORIGIN_SECRET_PORTAL'
      },
      allowedMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
      cachePolicy: 'assets-only',
      cookieDomainPolicy: 'strip'
    }
  };
  return {
    format: 'edge-app-gateway.variables',
    version: 1,
    worker: {
      name: 'lx-cm-route',
      customDomains: ['portal.preview.example.com']
    },
    vars: {
      ROUTE_BASE_DOMAIN: 'preview.example.com',
      ROUTE_SESSION_TTL_SECONDS: '28800'
    },
    secrets: {
      ROUTE_PROJECTS_JSON: JSON.stringify(projects),
      ORIGIN_SECRET_PORTAL: 'test-origin-secret-that-must-never-be-logged'
    }
  };
}

test('validates a multi-application variables file without logging secret values', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge-gateway-config-'));
  const configPath = join(temporaryDirectory, 'gateway.variables.json');
  const originSecret = 'origin-secret-value-that-must-not-appear-in-output-1234567890';
  const projects = {
    smartdata: {
      target: 'https://smart-data.vercel.app',
      deliveryMode: 'proxy',
      proxyProfile: 'fullstack',
      requestOriginPolicy: 'rewrite-to-upstream',
      edgeAccess: { mode: 'disabled' },
      originProtection: {
        mode: 'required',
        headerName: 'x-edge-app-gateway-origin',
        secretBinding: 'ORIGIN_SECRET_SMARTDATA'
      },
      allowedMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
      cachePolicy: 'assets-only',
      cookieDomainPolicy: 'strip'
    },
    portal: {
      target: 'https://portal-app.vercel.app',
      deliveryMode: 'proxy',
      proxyProfile: 'fullstack',
      requestOriginPolicy: 'rewrite-to-upstream',
      edgeAccess: { mode: 'disabled' },
      originProtection: { mode: 'disabled' },
      allowedMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
      cachePolicy: 'no-store',
      cookieDomainPolicy: 'strip'
    }
  };
  const variablesFile = {
    format: 'edge-app-gateway.variables',
    version: 1,
    worker: {
      name: 'lx-cm-route',
      customDomains: ['smartdata.preview.example.com', 'portal.preview.example.com']
    },
    vars: {
      ROUTE_BASE_DOMAIN: 'preview.example.com',
      ROUTE_SESSION_TTL_SECONDS: '28800'
    },
    secrets: {
      ROUTE_PROJECTS_JSON: JSON.stringify(projects),
      ORIGIN_SECRET_SMARTDATA: originSecret
    }
  };

  try {
    await writeFile(configPath, JSON.stringify(variablesFile), { mode: 0o600 });
    const result = spawnSync(process.execPath, deployArguments(configPath, '--check'), {
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /应用数量：2/);
    assert.match(result.stdout, /ORIGIN_SECRET_SMARTDATA/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(originSecret));

    const dryRunResult = spawnSync(process.execPath, deployArguments(configPath, '--dry-run'), {
      encoding: 'utf8'
    });
    assert.equal(dryRunResult.status, 0, dryRunResult.stderr);
    assert.match(dryRunResult.stdout, /--dry-run: exiting now/);
    assert.doesNotMatch(dryRunResult.stdout + dryRunResult.stderr, new RegExp(originSecret));
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('targets different Workers with isolated rate limiter namespaces', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge-gateway-multi-worker-'));
  const existingPath = join(temporaryDirectory, 'existing.variables.json');
  const isolatedPath = join(temporaryDirectory, 'isolated.variables.json');
  const existing = createVariablesFile();
  const isolated = createVariablesFile();
  isolated.worker = {
    name: 'personal-site',
    rateLimitNamespaceId: '1545396235',
    customDomains: ['portal.preview.example.com']
  };

  try {
    await writeFile(existingPath, JSON.stringify(existing), { mode: 0o600 });
    await writeFile(isolatedPath, JSON.stringify(isolated), { mode: 0o600 });
    const existingResult = spawnSync(process.execPath, deployArguments(existingPath, '--check'), {
      encoding: 'utf8'
    });
    const isolatedResult = spawnSync(
      process.execPath,
      deployArguments(isolatedPath, '--check', 'personal-site'),
      {
        encoding: 'utf8'
      }
    );

    assert.equal(existingResult.status, 0, existingResult.stderr);
    assert.equal(isolatedResult.status, 0, isolatedResult.stderr);
    assert.match(existingResult.stdout, /Worker lx-cm-route/);
    assert.match(existingResult.stdout, /Rate Limiter Namespace：1001/);
    assert.match(isolatedResult.stdout, /Worker personal-site/);
    assert.match(isolatedResult.stdout, /Rate Limiter Namespace：1545396235/);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('requires an explicit Worker name and rejects a variables-file mismatch', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge-gateway-worker-target-'));
  const configPath = join(temporaryDirectory, 'gateway.variables.json');

  try {
    await writeFile(configPath, JSON.stringify(createVariablesFile()), { mode: 0o600 });
    const missingWorker = spawnSync(process.execPath, [deployScript, configPath, '--check'], {
      encoding: 'utf8'
    });
    const mismatchedWorker = spawnSync(
      process.execPath,
      deployArguments(configPath, '--check', 'personal-site'),
      { encoding: 'utf8' }
    );

    assert.equal(missingWorker.status, 1);
    assert.match(missingWorker.stderr, /--worker/);
    assert.equal(mismatchedWorker.status, 1);
    assert.match(mismatchedWorker.stderr, /\[Worker 不匹配\]/);
    assert.match(mismatchedWorker.stderr, /personal-site/);
    assert.match(mismatchedWorker.stderr, /lx-cm-route/);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('retargets a sensitive variables file without overwriting or logging secrets', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge-gateway-retarget-'));
  const sourcePath = join(temporaryDirectory, 'vercel-route.production.variables.json');
  const destinationPath = join(temporaryDirectory, 'lx-cm-route.production.variables.json');
  const variablesFile = createVariablesFile();
  variablesFile.worker.name = 'vercel-route';

  try {
    await writeFile(sourcePath, JSON.stringify(variablesFile), { mode: 0o600 });
    const result = spawnSync(process.execPath, [retargetScript, sourcePath, 'lx-cm-route'], {
      encoding: 'utf8'
    });
    const original = JSON.parse(await readFile(sourcePath, 'utf8'));
    const retargeted = JSON.parse(await readFile(destinationPath, 'utf8'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(original.worker.name, 'vercel-route');
    assert.equal(original.worker.rateLimitNamespaceId, undefined);
    assert.equal(retargeted.worker.name, 'lx-cm-route');
    assert.equal(retargeted.worker.rateLimitNamespaceId, '1001');
    assert.deepEqual(retargeted.vars, original.vars);
    assert.deepEqual(retargeted.secrets, original.secrets);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /test-origin-secret-that-must-never-be-logged/
    );

    const overwrite = spawnSync(process.execPath, [retargetScript, sourcePath, 'lx-cm-route'], {
      encoding: 'utf8'
    });
    assert.equal(overwrite.status, 1);
    assert.match(overwrite.stderr, /拒绝覆盖/);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('rejects an invalid rate limiter namespace', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge-gateway-rate-limit-'));
  const configPath = join(temporaryDirectory, 'invalid.variables.json');
  const variablesFile = createVariablesFile();
  variablesFile.worker.rateLimitNamespaceId = '0';

  try {
    await writeFile(configPath, JSON.stringify(variablesFile), { mode: 0o600 });
    const result = spawnSync(process.execPath, deployArguments(configPath, '--check'), {
      encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rateLimitNamespaceId 无效/);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('rejects a variables file whose custom domains do not match its aliases', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge-gateway-config-invalid-'));
  const configPath = join(temporaryDirectory, 'invalid.variables.json');
  const projects = {
    portal: {
      target: 'https://portal-app.vercel.app',
      deliveryMode: 'proxy',
      proxyProfile: 'fullstack',
      requestOriginPolicy: 'rewrite-to-upstream',
      edgeAccess: { mode: 'disabled' },
      originProtection: { mode: 'disabled' },
      allowedMethods: ['GET', 'HEAD'],
      cachePolicy: 'no-store',
      cookieDomainPolicy: 'strip'
    }
  };

  try {
    await writeFile(configPath, JSON.stringify({
      format: 'edge-app-gateway.variables',
      version: 1,
      worker: { name: 'lx-cm-route', customDomains: ['wrong.preview.example.com'] },
      vars: {
        ROUTE_BASE_DOMAIN: 'preview.example.com',
        ROUTE_SESSION_TTL_SECONDS: '28800'
      },
      secrets: { ROUTE_PROJECTS_JSON: JSON.stringify(projects) }
    }), { mode: 0o600 });

    const result = spawnSync(process.execPath, deployArguments(configPath, '--check'), {
      encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Custom Domains/);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('rejects sharing one Origin Secret Binding across projects', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge-gateway-config-binding-'));
  const configPath = join(temporaryDirectory, 'duplicate-binding.variables.json');
  const createProject = target => ({
    target,
    deliveryMode: 'proxy',
    proxyProfile: 'fullstack',
    requestOriginPolicy: 'rewrite-to-upstream',
    edgeAccess: { mode: 'disabled' },
    originProtection: {
      mode: 'required',
      headerName: 'x-edge-app-gateway-origin',
      secretBinding: 'ORIGIN_SECRET_SHARED'
    },
    allowedMethods: ['GET', 'HEAD'],
    cachePolicy: 'no-store',
    cookieDomainPolicy: 'strip'
  });
  const projects = {
    alpha: createProject('https://alpha-app.vercel.app'),
    bravo: createProject('https://bravo-app.vercel.app')
  };

  try {
    await writeFile(configPath, JSON.stringify({
      format: 'edge-app-gateway.variables',
      version: 1,
      worker: {
        name: 'lx-cm-route',
        customDomains: ['alpha.preview.example.com', 'bravo.preview.example.com']
      },
      vars: {
        ROUTE_BASE_DOMAIN: 'preview.example.com',
        ROUTE_SESSION_TTL_SECONDS: '28800'
      },
      secrets: {
        ROUTE_PROJECTS_JSON: JSON.stringify(projects),
        ORIGIN_SECRET_SHARED: 'shared-secret-that-must-be-rejected'
      }
    }), { mode: 0o600 });

    const result = spawnSync(process.execPath, deployArguments(configPath, '--check'), {
      encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /不能共用 Origin Secret Binding/);
    assert.doesNotMatch(result.stderr, /shared-secret-that-must-be-rejected/);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('runs the recommended command from the repository root and worker directory', async () => {
  const fileName = `test-${process.pid}-${Date.now()}.variables.json`;
  const configPath = join(repositoryDirectory, fileName);

  try {
    await writeFile(configPath, JSON.stringify(createVariablesFile()), { mode: 0o600 });

    const rootResult = spawnSync(
      'npm',
      [
        '--prefix', 'cloudflare-worker', 'run', 'deploy:config', '--',
        `../${fileName}`, '--worker', 'lx-cm-route', '--check'
      ],
      { cwd: repositoryDirectory, encoding: 'utf8' }
    );
    assert.equal(rootResult.status, 0, rootResult.stderr);
    assert.match(rootResult.stdout, /校验通过：Worker lx-cm-route/);

    const workerResult = spawnSync(
      'npm',
      ['run', 'deploy:config', '--', `../${fileName}`, '--worker', 'lx-cm-route', '--check'],
      { cwd: workerDirectory, encoding: 'utf8' }
    );
    assert.equal(workerResult.status, 0, workerResult.stderr);
    assert.match(workerResult.stdout, /校验通过：Worker lx-cm-route/);

    const autoLocatedResult = spawnSync(
      'npm',
      ['run', 'deploy:config', '--', fileName, '--worker', 'lx-cm-route', '--check'],
      { cwd: workerDirectory, encoding: 'utf8' }
    );
    assert.equal(autoLocatedResult.status, 0, autoLocatedResult.stderr);
  } finally {
    await rm(configPath);
  }
});

test('accepts an absolute variables-file path containing spaces', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge gateway config '));
  const configPath = join(temporaryDirectory, 'gateway variables.json');

  try {
    await writeFile(configPath, JSON.stringify(createVariablesFile()), { mode: 0o600 });
    const quotedPath = `'${configPath.replaceAll("'", "'\\''")}'`;
    const result = spawnSync('sh', ['-c', [
      'npm --prefix cloudflare-worker run deploy:config --',
      quotedPath,
      '--worker lx-cm-route',
      '--check'
    ].join(' ')], {
      cwd: repositoryDirectory,
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /校验通过：Worker lx-cm-route/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-origin-secret-that-must-never-be-logged/);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('reports a resolved missing path and an executable root-directory repair command', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge-gateway-missing-'));
  const missingPath = join(temporaryDirectory, 'missing variables.json');

  try {
    const result = spawnSync(
      process.execPath,
      deployArguments('./missing variables.json', '--check'),
      {
        cwd: temporaryDirectory,
        encoding: 'utf8'
      }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[文件不存在\]/);
    assert.match(result.stderr, new RegExp(missingPath.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result.stderr, /请先进入仓库根目录/);
    assert.match(result.stderr, /npm --prefix cloudflare-worker run deploy:config/);
    assert.match(result.stderr, /'\.\.\/missing variables\.json' --worker '<worker-name>' --check/);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('classifies invalid JSON without echoing file contents', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge-gateway-json-'));
  const configPath = join(temporaryDirectory, 'invalid.variables.json');
  const sensitiveFragment = 'secret-value-that-must-not-be-echoed';

  try {
    await writeFile(configPath, `{ "secret": "${sensitiveFragment}"`, { mode: 0o600 });
    const result = spawnSync(process.execPath, deployArguments(configPath, '--check'), {
      encoding: 'utf8'
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[JSON 无效\]/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sensitiveFragment));
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('--check stays local and --dry-run never reports a formal deployment', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge-gateway-modes-'));
  const configPath = join(temporaryDirectory, 'gateway.variables.json');

  try {
    await writeFile(configPath, JSON.stringify(createVariablesFile()), { mode: 0o600 });
    const checkResult = spawnSync(process.execPath, deployArguments(configPath, '--check'), {
      encoding: 'utf8',
      env: { ...process.env, CLOUDFLARE_API_TOKEN: 'intentionally-invalid-token' }
    });
    assert.equal(checkResult.status, 0, checkResult.stderr);
    assert.doesNotMatch(checkResult.stdout + checkResult.stderr, /wrangler|Cloudflare API/i);

    const dryRunResult = spawnSync(process.execPath, deployArguments(configPath, '--dry-run'), {
      encoding: 'utf8',
      env: { ...process.env, CLOUDFLARE_API_TOKEN: 'intentionally-invalid-token' }
    });
    assert.equal(dryRunResult.status, 0, dryRunResult.stderr);
    assert.match(dryRunResult.stdout, /--dry-run: exiting now/);
    assert.doesNotMatch(dryRunResult.stdout, /部署完成|Version ID：/);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('classifies missing Secrets without printing values', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'edge-gateway-secret-'));
  const configPath = join(temporaryDirectory, 'missing-secret.variables.json');
  const variablesFile = createVariablesFile();
  delete variablesFile.secrets.ORIGIN_SECRET_PORTAL;

  try {
    await writeFile(configPath, JSON.stringify(variablesFile), { mode: 0o600 });
    const result = spawnSync(process.execPath, deployArguments(configPath, '--check'), {
      encoding: 'utf8'
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[Secret 缺失\]/);
    assert.match(result.stderr, /ORIGIN_SECRET_PORTAL/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-origin-secret-that-must-never-be-logged/);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

test('provides actionable dependency, login, deployment and health output', () => {
  assert.match(deployScriptSource, /npm --prefix cloudflare-worker install/);
  assert.match(deployScriptSource, /cd cloudflare-worker/);
  assert.match(deployScriptSource, /npx wrangler whoami/);
  assert.match(deployScriptSource, /npx wrangler login/);
  assert.match(deployScriptSource, /Worker 名称：/);
  assert.match(deployScriptSource, /代码部署 Version ID：/);
  assert.match(deployScriptSource, /最终活动 Version ID：/);
  assert.match(deployScriptSource, /公开健康检查命令：/);
  assert.match(deployScriptSource, /createWorkerInstanceConfig/);
  assert.match(deployScriptSource, /'--config'/);
  assert.match(deployScriptSource, /'deployments',\s*'list'/);
  assert.match(deployScriptSource, /redactSecrets/);
});
