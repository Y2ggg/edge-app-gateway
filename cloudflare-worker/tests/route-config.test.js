import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isValidRouteAlias,
  parseRouteProjects,
  RouteConfigurationError
} from '../lib/route-config.js';

function fullstackProject(overrides = {}) {
  return {
    target: 'https://project-a.vercel.app',
    deliveryMode: 'proxy',
    proxyProfile: 'fullstack',
    requestOriginPolicy: 'rewrite-to-upstream',
    edgeAccess: { mode: 'disabled' },
    entryAccess: { mode: 'disabled' },
    originProtection: {
      mode: 'required',
      headerName: 'x-edge-app-gateway-origin',
      secretBinding: 'ORIGIN_SECRET_PROJECT_A'
    },
    allowedMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    cachePolicy: 'assets-only',
    ...overrides
  };
}

test('parses the explicit route protocol and normalizes method order', () => {
  const projects = parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({
      allowedMethods: ['POST', 'OPTIONS', 'GET', 'HEAD'],
      cookieDomainPolicy: 'rewrite'
    })
  }));

  assert.deepEqual(projects.get('project-a7f3'), {
    target: 'https://project-a.vercel.app/',
    deliveryMode: 'proxy',
    proxyProfile: 'fullstack',
    requestOriginPolicy: 'rewrite-to-upstream',
    edgeAccess: { mode: 'disabled' },
    entryAccess: { mode: 'disabled' },
    originProtection: {
      mode: 'required',
      headerName: 'x-edge-app-gateway-origin',
      secretBinding: 'ORIGIN_SECRET_PROJECT_A'
    },
    allowedMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    cachePolicy: 'assets-only',
    cookieDomainPolicy: 'rewrite'
  });
});

test('requires a password hash only when Edge Access is required', () => {
  const disabled = parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({
      edgeAccess: { mode: 'disabled', passwordHash: 'ignored' }
    })
  }));

  assert.deepEqual(disabled.get('project-a7f3').edgeAccess, { mode: 'disabled' });
  assert.throws(() => parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({ edgeAccess: { mode: 'required' } })
  })), RouteConfigurationError);

  const required = parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({
      edgeAccess: { mode: 'required', passwordHash: 'hmac-sha256$hash' }
    })
  }));
  assert.equal(required.get('project-a7f3').edgeAccess.passwordHash, 'hmac-sha256$hash');
});

test('validates entry-only access relationships and defaults', () => {
  const projects = parseRouteProjects(JSON.stringify({
    'portal-a7f3': fullstackProject({
      target: 'https://portal.vercel.app',
      edgeAccess: { mode: 'required', passwordHash: 'hmac-sha256$portal' }
    }),
    'project-a7f3': fullstackProject({
      entryAccess: { mode: 'required', entryAlias: 'portal-a7f3', ttlSeconds: 900 }
    })
  }));

  assert.deepEqual(projects.get('portal-a7f3').entryAccess, { mode: 'disabled' });
  assert.deepEqual(projects.get('project-a7f3').entryAccess, {
    mode: 'required',
    entryAlias: 'portal-a7f3',
    ttlSeconds: 900
  });

  for (const projectOverrides of [
    { entryAccess: { mode: 'required', entryAlias: 'missing-a7f3' } },
    { entryAccess: { mode: 'required', entryAlias: 'project-a7f3' } },
    { entryAccess: { mode: 'required', entryAlias: 'portal-a7f3', ttlSeconds: 60 } },
    {
      deliveryMode: 'redirect',
      requestOriginPolicy: 'preserve',
      originProtection: { mode: 'disabled' },
      allowedMethods: ['GET', 'HEAD'],
      entryAccess: { mode: 'required', entryAlias: 'portal-a7f3' }
    }
  ]) {
    assert.throws(() => parseRouteProjects(JSON.stringify({
      'portal-a7f3': fullstackProject({ target: 'https://portal.vercel.app' }),
      'project-a7f3': fullstackProject(projectOverrides)
    })), RouteConfigurationError);
  }
});

test('defaults to preserving request origins and validates explicit rewrite policy', () => {
  const projects = parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({ requestOriginPolicy: undefined })
  }));

  assert.equal(projects.get('project-a7f3').requestOriginPolicy, 'preserve');
  assert.throws(() => parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({ requestOriginPolicy: 'trust-all' })
  })), RouteConfigurationError);
  assert.throws(() => parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({
      deliveryMode: 'redirect',
      requestOriginPolicy: 'rewrite-to-upstream',
      originProtection: { mode: 'disabled' },
      allowedMethods: ['GET', 'HEAD']
    })
  })), RouteConfigurationError);
});

test('requires a binding only when origin protection is required', () => {
  const disabled = parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({
      originProtection: {
        mode: 'disabled',
        headerName: 'ignored',
        secretBinding: 'ignored'
      }
    })
  }));
  assert.deepEqual(disabled.get('project-a7f3').originProtection, { mode: 'disabled' });

  for (const originProtection of [
    { mode: 'required', headerName: 'x-edge-app-gateway-origin' },
    { mode: 'required', headerName: 'cookie', secretBinding: 'ORIGIN_SECRET_A' },
    { mode: 'required', headerName: 'x-vercel-protection-bypass', secretBinding: 'ORIGIN_SECRET_A' },
    { mode: 'required', headerName: 'x-origin', secretBinding: 'not-valid' }
  ]) {
    assert.throws(() => parseRouteProjects(JSON.stringify({
      'project-a7f3': fullstackProject({ originProtection })
    })), RouteConfigurationError);
  }
});

test('rejects redirect delivery with origin protection and write methods', () => {
  assert.throws(() => parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({ deliveryMode: 'redirect' })
  })), RouteConfigurationError);

  assert.throws(() => parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({
      deliveryMode: 'redirect',
      requestOriginPolicy: 'preserve',
      originProtection: { mode: 'disabled' }
    })
  })), RouteConfigurationError);

  const projects = parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({
      deliveryMode: 'redirect',
      requestOriginPolicy: 'preserve',
      originProtection: { mode: 'disabled' },
      allowedMethods: ['GET', 'HEAD']
    })
  }));
  assert.equal(projects.get('project-a7f3').deliveryMode, 'redirect');
});

test('validates method profiles and returns a canonical Allow order', () => {
  assert.throws(() => parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({
      proxyProfile: 'static',
      allowedMethods: ['GET', 'POST']
    })
  })), RouteConfigurationError);

  assert.throws(() => parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({ allowedMethods: ['GET', 'TRACE'] })
  })), RouteConfigurationError);

  assert.throws(() => parseRouteProjects(JSON.stringify({
    'project-a7f3': fullstackProject({ allowedMethods: ['GET', 'get'] })
  })), RouteConfigurationError);
});

test('does not accept the former implicit passwordHash protocol', () => {
  assert.throws(() => parseRouteProjects(JSON.stringify({
    'project-a7f3': {
      target: 'https://project-a.vercel.app',
      passwordHash: 'old-layout'
    }
  })), RouteConfigurationError);
});

test('validates aliases consistently', () => {
  assert.equal(isValidRouteAlias('app-a7f3'), true);
  assert.equal(isValidRouteAlias('ab'), false);
  assert.equal(isValidRouteAlias('UPPERCASE'), false);
  assert.equal(isValidRouteAlias('app_name'), false);
  assert.equal(isValidRouteAlias('../admin'), false);
});

test('rejects non-HTTPS and credential-bearing targets', () => {
  const invalidTargets = [
    'http://project.vercel.app',
    'javascript:alert(1)',
    'https://user:pass@project.vercel.app',
    'https://project.vercel.app/#private',
    'https://project.vercel.app/?source=route',
    'https://untrusted.example'
  ];

  for (const target of invalidTargets) {
    assert.throws(() => parseRouteProjects(JSON.stringify({
      'app-a7f3': fullstackProject({ target })
    })), RouteConfigurationError);
  }
});

test('rejects missing, malformed, and empty configuration', () => {
  assert.throws(() => parseRouteProjects(), RouteConfigurationError);
  assert.throws(() => parseRouteProjects('{broken'), RouteConfigurationError);
  assert.throws(() => parseRouteProjects('{}'), RouteConfigurationError);
  assert.throws(() => parseRouteProjects('[]'), RouteConfigurationError);
});
