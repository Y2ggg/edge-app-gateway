import assert from 'node:assert/strict';
import test from 'node:test';

import { handleWorkerRequest } from '../src/worker.js';
import {
  createWorkerPasswordHash,
  createWorkerSessionToken
} from '../src/worker-crypto.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const PASSWORD = 'docs-password';
const PASSWORD_HASH = await createWorkerPasswordHash(PASSWORD, {
  secret: SECRET,
  salt: new TextEncoder().encode('0123456789abcdef')
});
const PROJECTS_JSON = JSON.stringify({
  'docs-a7f3': {
    target: 'https://docs-project.vercel.app',
    passwordHash: PASSWORD_HASH
  }
});

function createEnvironment(overrides = {}) {
  return {
    ROUTE_PROJECTS_JSON: PROJECTS_JSON,
    ROUTE_SESSION_SECRET: SECRET,
    ROUTE_SESSION_TTL_SECONDS: '600',
    ...overrides
  };
}

test('exposes a minimal health endpoint without target details', async () => {
  const response = await handleWorkerRequest(
    new Request('https://route-worker.example.workers.dev/__route/health'),
    {}
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(result, {
    ok: true,
    build: '2026-08-03-route-v2',
    edge: 'local'
  });
});

test('redirects an unauthenticated workers.dev document to login', async () => {
  const response = await handleWorkerRequest(
    new Request('https://route-worker.example.workers.dev/guide?lang=zh', {
      headers: { Accept: 'text/html' }
    }),
    createEnvironment()
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get('location'),
    '/__route/login?next=%2Fguide%3Flang%3Dzh'
  );
});

test('renders login without exposing upstream configuration', async () => {
  const response = await handleWorkerRequest(
    new Request('https://route-worker.example.workers.dev/__route/login'),
    createEnvironment()
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /访问验证/);
  assert.equal(html.includes('docs-a7f3'), false);
  assert.equal(html.includes('docs-project.vercel.app'), false);
  assert.equal(html.includes(PASSWORD_HASH), false);
});

test('authenticates the only configured project and sets a secure session', async () => {
  const response = await authenticate(PASSWORD);

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/__route/success?next=%2Fguide');
  assert.match(response.headers.get('set-cookie'), /^route_session=/);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /Secure/);
});

test('rejects an opaque Origin even when Fetch Metadata claims same-origin', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  let response;

  try {
    response = await handleWorkerRequest(
      new Request('https://route-worker.example.workers.dev/__route/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'null',
          'Sec-Fetch-Site': 'same-origin'
        },
        body: new URLSearchParams({ password: PASSWORD, next: '/guide' })
      }),
      createEnvironment()
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /error=unavailable/);
  assert.deepEqual(warnings, ['Worker authentication rejected: origin-mismatch']);
});

test('allows a missing Origin only with same-origin Fetch Metadata', async () => {
  const response = await handleWorkerRequest(
    new Request('https://route-worker.example.workers.dev/__route/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin'
      },
      body: new URLSearchParams({ password: PASSWORD, next: '/guide' })
    }),
    createEnvironment()
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/__route/success?next=%2Fguide');
  assert.match(response.headers.get('set-cookie'), /^route_session=/);
});

test('rejects an opaque Origin from a cross-site request', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  let response;

  try {
    response = await handleWorkerRequest(
      new Request('https://route-worker.example.workers.dev/__route/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'null',
          'Sec-Fetch-Site': 'cross-site'
        },
        body: new URLSearchParams({ password: PASSWORD, next: '/guide' })
      }),
      createEnvironment()
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /error=unavailable/);
  assert.deepEqual(warnings, ['Worker authentication rejected: origin-mismatch']);
});

test('rejects an incorrect project password', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  let response;

  try {
    response = await authenticate('wrong-password');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /error=unavailable/);
  assert.equal(response.headers.has('set-cookie'), false);
  assert.deepEqual(warnings, ['Worker authentication rejected: password-mismatch']);
});

test('shows the same validation flow for an unknown project alias', async () => {
  const environment = createEnvironment({
    ROUTE_BASE_DOMAIN: 'preview.example.com'
  });
  const initialResponse = await handleWorkerRequest(
    new Request('https://unknown.preview.example.com/', {
      headers: { Accept: 'text/html' }
    }),
    environment
  );
  const authResponse = await handleWorkerRequest(
    new Request('https://unknown.preview.example.com/__route/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://unknown.preview.example.com'
      },
      body: new URLSearchParams({ password: 'anything', next: '/' })
    }),
    environment
  );

  assert.equal(initialResponse.status, 303);
  assert.match(initialResponse.headers.get('location'), /^\/__route\/login/);
  assert.equal(authResponse.status, 303);
  assert.equal(
    authResponse.headers.get('location'),
    '/__route/login?error=unavailable&next=%2F'
  );
});

test('renders matching success and generic unavailable states', async () => {
  const success = await handleWorkerRequest(
    new Request('https://route-worker.example.workers.dev/__route/success?next=%2Fguide'),
    createEnvironment()
  );
  const unavailable = await handleWorkerRequest(
    new Request('https://route-worker.example.workers.dev/__route/unavailable'),
    createEnvironment()
  );
  const successHtml = await success.text();
  const unavailableHtml = await unavailable.text();

  assert.match(successHtml, /验证通过/);
  assert.match(successHtml, /正在进入/);
  assert.equal(success.headers.get('referrer-policy'), 'same-origin');
  assert.match(unavailableHtml, /<h1>无法访问<\/h1>/);
  assert.doesNotMatch(unavailableHtml, /密码|站点|上游|配置|地址/);
});

test('proxies authenticated content and rewrites the upstream origin', async () => {
  const token = await createWorkerSessionToken('docs-a7f3', SECRET, {
    ttlSeconds: 600
  });
  let requestedUrl;
  const response = await handleWorkerRequest(
    new Request('https://route-worker.example.workers.dev/assets/page.html?lang=zh', {
      headers: {
        Accept: 'text/html',
        Cookie: `route_session=${token}`
      }
    }),
    createEnvironment({
      ROUTE_PROJECTS_JSON: JSON.stringify({
        'docs-a7f3': {
          target: 'https://docs-project.vercel.app',
          passwordHash: PASSWORD_HASH,
          rewriteOrigins: true
        }
      })
    }),
    {
      fetchImpl: async url => {
        requestedUrl = url.toString();
        return new Response(
          '<a href="https://docs-project.vercel.app/help">help</a>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    }
  );

  assert.equal(requestedUrl, 'https://docs-project.vercel.app/assets/page.html?lang=zh');
  assert.equal(response.status, 200);
  assert.equal(
    await response.text(),
    '<a href="https://route-worker.example.workers.dev/help">help</a>'
  );
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('passes response bodies through unchanged by default', async () => {
  const token = await createWorkerSessionToken('docs-a7f3', SECRET);
  const upstreamHtml = '<script>window.runtime="https://docs-project.vercel.app"</script>';
  const projectsJson = JSON.stringify({
    'docs-a7f3': {
      target: 'https://docs-project.vercel.app',
      passwordHash: PASSWORD_HASH
    }
  });
  const response = await handleWorkerRequest(
    new Request('https://route-worker.example.workers.dev/', {
      headers: {
        Accept: 'text/html',
        Cookie: `route_session=${token}`
      }
    }),
    createEnvironment({ ROUTE_PROJECTS_JSON: projectsJson }),
    {
      fetchImpl: async () => new Response(upstreamHtml, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          ETag: '"raw"'
        }
      })
    }
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), upstreamHtml);
  assert.equal(response.headers.get('etag'), '"raw"');
});

test('resolves project aliases from a configured Cloudflare hostname', async () => {
  const token = await createWorkerSessionToken('docs-a7f3', SECRET);
  const response = await handleWorkerRequest(
    new Request('https://docs-a7f3.preview.example.com/', {
      headers: {
        Accept: 'text/html',
        Cookie: `route_session=${token}`
      }
    }),
    createEnvironment({
      ROUTE_BASE_DOMAIN: 'preview.example.com'
    }),
    {
      fetchImpl: async () => new Response('ok', {
        headers: { 'Content-Type': 'text/plain' }
      })
    }
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
});

test('requires hostname routing when multiple projects are configured', async () => {
  const response = await handleWorkerRequest(
    new Request('https://route.example.com/__route/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://route.example.com'
      },
      body: new URLSearchParams({ password: PASSWORD, next: '/' })
    }),
    createEnvironment({
      ROUTE_PROJECTS_JSON: JSON.stringify({
        'docs-a7f3': {
          target: 'https://docs-project.vercel.app',
          passwordHash: PASSWORD_HASH
        },
        'admin-b8e4': {
          target: 'https://admin-project.vercel.app',
          passwordHash: PASSWORD_HASH
        }
      })
    })
  );

  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /error=unavailable/);
});

test('does not mutate executable JavaScript bundles', async () => {
  const token = await createWorkerSessionToken('docs-a7f3', SECRET);
  const bundle = 'const n={"https://docs-project.vercel.app":()=>42};n[location.origin]();';
  const response = await handleWorkerRequest(
    new Request('https://route-worker.example.workers.dev/assets/vendor.js', {
      headers: {
        Accept: '*/*',
        Cookie: `route_session=${token}`
      }
    }),
    createEnvironment(),
    {
      fetchImpl: async () => new Response(bundle, {
        headers: { 'Content-Type': 'application/javascript' }
      })
    }
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), bundle);
});

test('uses one visual failure for unreachable and failing upstream sites', async () => {
  const token = await createWorkerSessionToken('docs-a7f3', SECRET);
  const request = new Request('https://route-worker.example.workers.dev/', {
    headers: {
      Accept: 'text/html',
      Cookie: `route_session=${token}`
    }
  });
  const fetchImplementations = [
    async () => {
      throw new TypeError('network failure');
    },
    async () => new Response('upstream detail', {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  ];

  for (const fetchImpl of fetchImplementations) {
    const response = await handleWorkerRequest(
      request.clone(),
      createEnvironment(),
      { fetchImpl }
    );

    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/__route/unavailable');
  }
});

async function authenticate(password) {
  return handleWorkerRequest(
    new Request('https://route-worker.example.workers.dev/__route/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://route-worker.example.workers.dev'
      },
      body: new URLSearchParams({ password, next: '/guide' })
    }),
    createEnvironment()
  );
}
