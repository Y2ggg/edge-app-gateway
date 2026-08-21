import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRequestOriginPolicy,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  copyUpstreamResponseHeaders,
  getSetCookieValues,
  rewriteLocation,
  rewriteSetCookieDomain,
  RequestOriginPolicyError,
  sanitizeNextPath
} from '../lib/proxy-utils.js';

test('joins a target base path and preserves the browser query', () => {
  const url = buildUpstreamUrl(
    'https://project.vercel.app/base/',
    '/assets/app.js',
    'version=2&lang=zh'
  );

  assert.equal(url.toString(), 'https://project.vercel.app/base/assets/app.js?version=2&lang=zh');
});

test('preserves application headers while removing gateway and hop-by-hop data', () => {
  const headers = buildUpstreamHeaders(new Headers({
    Accept: 'application/json',
    Authorization: 'Bearer application-token',
    Connection: 'keep-alive, x-remove-me',
    'Content-Type': 'application/json',
    Cookie: 'route_session=gateway-private; app_session=application-private; theme=dark',
    Origin: 'https://data.example.com',
    'X-Edge-App-Gateway-Origin': 'forged',
    'X-Vercel-Protection-Bypass': 'client-bypass',
    'X-Remove-Me': 'private',
    'X-Forwarded-For': 'forged'
  }), {
    sessionCookieName: 'route_session',
    originHeaderName: 'x-edge-app-gateway-origin',
    originSecret: 'server-origin-secret',
    clientHost: 'data.example.com',
    clientIp: '203.0.113.10'
  });

  assert.equal(headers.get('authorization'), 'Bearer application-token');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('cookie'), 'app_session=application-private; theme=dark');
  assert.equal(headers.get('origin'), 'https://data.example.com');
  assert.equal(headers.get('x-edge-app-gateway-origin'), 'server-origin-secret');
  assert.equal(headers.get('x-forwarded-for'), '203.0.113.10');
  assert.equal(headers.get('x-forwarded-host'), 'data.example.com');
  assert.equal(headers.has('connection'), false);
  assert.equal(headers.has('x-remove-me'), false);
  assert.equal(headers.has('x-vercel-protection-bypass'), false);
});

test('copies end-to-end response headers and removes hop-by-hop headers', () => {
  const upstream = new Headers({
    'Cache-Control': 'public, max-age=60',
    Connection: 'x-private',
    'Content-Type': 'application/json',
    Location: '/next',
    'X-Private': 'remove-me',
    'X-Upstream': 'preserve-me'
  });
  const headers = copyUpstreamResponseHeaders(upstream);

  assert.equal(headers.get('cache-control'), 'public, max-age=60');
  assert.equal(headers.get('location'), '/next');
  assert.equal(headers.get('x-upstream'), 'preserve-me');
  assert.equal(headers.has('connection'), false);
  assert.equal(headers.has('x-private'), false);
});

test('rewrites same-origin Origin and Referer to the upstream origin', () => {
  const headers = new Headers({
    Origin: 'https://data.example.com',
    Referer: 'https://data.example.com/access/login?next=%2Fdashboard'
  });

  applyRequestOriginPolicy(headers, {
    requestOriginPolicy: 'rewrite-to-upstream',
    clientOrigin: 'https://data.example.com',
    upstreamOrigin: 'https://project.vercel.app'
  });

  assert.equal(headers.get('origin'), 'https://project.vercel.app');
  assert.equal(
    headers.get('referer'),
    'https://project.vercel.app/access/login?next=%2Fdashboard'
  );
});

test('rejects cross-site, opaque and malformed Origin values before proxying', () => {
  for (const origin of [
    'https://attacker.example',
    'null',
    'https://data.example.com/path',
    'https://data.example.com, https://attacker.example'
  ]) {
    const headers = new Headers({ Origin: origin });

    assert.throws(() => applyRequestOriginPolicy(headers, {
      requestOriginPolicy: 'rewrite-to-upstream',
      clientOrigin: 'https://data.example.com',
      upstreamOrigin: 'https://project.vercel.app'
    }), RequestOriginPolicyError);
  }
});

test('allows requests without Origin and only rewrites same-origin Referer', () => {
  const serverRequest = new Headers({ Authorization: 'Bearer server-client' });
  applyRequestOriginPolicy(serverRequest, {
    requestOriginPolicy: 'rewrite-to-upstream',
    clientOrigin: 'https://data.example.com',
    upstreamOrigin: 'https://project.vercel.app'
  });
  assert.equal(serverRequest.has('origin'), false);

  const externalNavigation = new Headers({ Referer: 'https://search.example/results?q=data' });
  applyRequestOriginPolicy(externalNavigation, {
    requestOriginPolicy: 'rewrite-to-upstream',
    clientOrigin: 'https://data.example.com',
    upstreamOrigin: 'https://project.vercel.app'
  });
  assert.equal(
    externalNavigation.get('referer'),
    'https://search.example/results?q=data'
  );
});

test('keeps multiple Set-Cookie values and applies the configured domain policy', () => {
  const headers = new Headers();
  headers.append('Set-Cookie', 'session=one; Path=/; HttpOnly');
  headers.append('Set-Cookie', 'theme=dark; Domain=project.vercel.app; Path=/');
  const values = getSetCookieValues(headers);

  assert.equal(values.length, 2);
  assert.equal(
    rewriteSetCookieDomain(values[1], 'data.example.com', 'strip'),
    'theme=dark; Path=/'
  );
  assert.equal(
    rewriteSetCookieDomain(values[1], 'data.example.com', 'rewrite'),
    'theme=dark; Domain=data.example.com; Path=/'
  );
});

test('does not duplicate a configured base path already present in the request', () => {
  const url = buildUpstreamUrl('https://project.vercel.app/base/', '/base/assets/app.js');
  assert.equal(url.toString(), 'https://project.vercel.app/base/assets/app.js');
});

test('rewrites only redirects pointing at the configured upstream origin', () => {
  const upstream = new URL('https://project.vercel.app/old');

  assert.equal(
    rewriteLocation('/new?tab=1', upstream, 'https://data.example.com'),
    'https://data.example.com/new?tab=1'
  );
  assert.equal(
    rewriteLocation('https://external.example/', upstream, 'https://data.example.com'),
    'https://external.example/'
  );
});

test('rejects unsafe post-login paths and the gateway namespace', () => {
  assert.equal(sanitizeNextPath('/guide?q=1'), '/guide?q=1');
  assert.equal(sanitizeNextPath('//evil.example'), '/');
  assert.equal(sanitizeNextPath('https://evil.example'), '/');
  assert.equal(sanitizeNextPath('/_edge-gateway/login'), '/');
});

test('prevents a request path from escaping a configured target base path', () => {
  assert.throws(
    () => buildUpstreamUrl('https://project.vercel.app/base/', '/../admin'),
    TypeError
  );
});
