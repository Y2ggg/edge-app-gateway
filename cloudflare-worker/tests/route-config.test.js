import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isValidRouteAlias,
  parseRouteProjects,
  RouteConfigurationError
} from '../lib/route-config.js';

test('parses configured HTTPS targets', () => {
  const projects = parseRouteProjects(JSON.stringify({
    'project-a7f3': {
      target: 'https://project-a.vercel.app',
      passwordHash: 'hash-a'
    },
    'docs-k9m2': {
      target: 'https://docs.vercel.app/guide',
      passwordHash: 'hash-b'
    }
  }));

  assert.deepEqual(projects.get('project-a7f3'), {
    target: 'https://project-a.vercel.app/',
    passwordHash: 'hash-a',
    rewriteOrigins: false
  });
  assert.deepEqual(projects.get('docs-k9m2'), {
    target: 'https://docs.vercel.app/guide',
    passwordHash: 'hash-b',
    rewriteOrigins: false
  });
});

test('allows body rewriting to be enabled for one project', () => {
  const projects = parseRouteProjects(JSON.stringify({
    'project-a7f3': {
      target: 'https://project-a.vercel.app',
      passwordHash: 'hash-a',
      rewriteOrigins: true
    }
  }));

  assert.equal(projects.get('project-a7f3').rewriteOrigins, true);
  assert.throws(() => parseRouteProjects(JSON.stringify({
    'project-a7f3': {
      target: 'https://project-a.vercel.app',
      passwordHash: 'hash-a',
      rewriteOrigins: 'false'
    }
  })), RouteConfigurationError);
});

test('validates aliases consistently', () => {
  assert.equal(isValidRouteAlias('app-a7f3'), true);
  assert.equal(isValidRouteAlias('ab'), false);
  assert.equal(isValidRouteAlias('UPPERCASE'), false);
  assert.equal(isValidRouteAlias('app_name'), false);
  assert.equal(isValidRouteAlias('../admin'), false);
  assert.equal(isValidRouteAlias('route/value'), false);
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
    assert.throws(
      () => parseRouteProjects(JSON.stringify({
        'app-a7f3': { target, passwordHash: 'hash-a' }
      })),
      RouteConfigurationError
    );
  }
});

test('rejects missing, malformed, and empty configuration', () => {
  assert.throws(() => parseRouteProjects(), RouteConfigurationError);
  assert.throws(() => parseRouteProjects('{broken'), RouteConfigurationError);
  assert.throws(() => parseRouteProjects('{}'), RouteConfigurationError);
  assert.throws(() => parseRouteProjects('[]'), RouteConfigurationError);
  assert.throws(
    () => parseRouteProjects(JSON.stringify({
      'app-a7f3': { target: 'https://project.vercel.app' }
    })),
    RouteConfigurationError
  );
});
