import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  rewriteLocation,
  sanitizeNextPath
} from '../lib/proxy-utils.js';

test('joins a target base path and preserves the browser query', () => {
  const url = buildUpstreamUrl(
    'https://project.vercel.app/base/',
    '/assets/app.js',
    'version=2&lang=zh'
  );

  assert.equal(
    url.toString(),
    'https://project.vercel.app/base/assets/app.js?version=2&lang=zh'
  );
});

test('forwards only allowlisted request headers', () => {
  const headers = buildUpstreamHeaders({
    accept: 'text/html',
    cookie: 'route_session=private',
    authorization: 'secret',
    range: 'bytes=0-100'
  });

  assert.equal(headers.get('accept'), 'text/html');
  assert.equal(headers.get('range'), 'bytes=0-100');
  assert.equal(headers.get('accept-encoding'), 'identity');
  assert.equal(headers.has('cookie'), false);
  assert.equal(headers.has('authorization'), false);
});

test('does not duplicate a configured base path already present in the request', () => {
  const url = buildUpstreamUrl(
    'https://project.vercel.app/base/',
    '/base/assets/app.js'
  );

  assert.equal(url.toString(), 'https://project.vercel.app/base/assets/app.js');
});

test('rewrites same-upstream redirects to the proxy origin', () => {
  const upstream = new URL('https://project.vercel.app/old');

  assert.equal(
    rewriteLocation('/new?tab=1', upstream, 'https://docs.route.example.com'),
    'https://docs.route.example.com/new?tab=1'
  );
  assert.equal(
    rewriteLocation('https://external.example/', upstream, 'https://docs.route.example.com'),
    'https://external.example/'
  );
});

test('rejects unsafe post-login paths', () => {
  assert.equal(sanitizeNextPath('/guide?q=1'), '/guide?q=1');
  assert.equal(sanitizeNextPath('//evil.example'), '/');
  assert.equal(sanitizeNextPath('https://evil.example'), '/');
  assert.equal(sanitizeNextPath('/__route/login'), '/');
});

test('prevents a request path from escaping a configured target base path', () => {
  assert.throws(
    () => buildUpstreamUrl('https://project.vercel.app/base/', '/../admin'),
    TypeError
  );
});
