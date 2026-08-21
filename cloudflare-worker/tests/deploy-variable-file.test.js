import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const deployScript = fileURLToPath(new URL('../scripts/deploy-variable-file.js', import.meta.url));

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
      name: 'vercel-route',
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
    const result = spawnSync(process.execPath, [deployScript, configPath, '--check'], {
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /应用数量：2/);
    assert.match(result.stdout, /ORIGIN_SECRET_SMARTDATA/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(originSecret));

    const dryRunResult = spawnSync(process.execPath, [deployScript, configPath, '--dry-run'], {
      encoding: 'utf8'
    });
    assert.equal(dryRunResult.status, 0, dryRunResult.stderr);
    assert.match(dryRunResult.stdout, /--dry-run: exiting now/);
    assert.doesNotMatch(dryRunResult.stdout + dryRunResult.stderr, new RegExp(originSecret));
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
      worker: { name: 'vercel-route', customDomains: ['wrong.preview.example.com'] },
      vars: {
        ROUTE_BASE_DOMAIN: 'preview.example.com',
        ROUTE_SESSION_TTL_SECONDS: '28800'
      },
      secrets: { ROUTE_PROJECTS_JSON: JSON.stringify(projects) }
    }), { mode: 0o600 });

    const result = spawnSync(process.execPath, [deployScript, configPath, '--check'], {
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
        name: 'vercel-route',
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

    const result = spawnSync(process.execPath, [deployScript, configPath, '--check'], {
      encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /不能共用 Origin Secret Binding/);
    assert.doesNotMatch(result.stderr, /shared-secret-that-must-be-rejected/);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});
