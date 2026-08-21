import assert from 'node:assert/strict';
import test from 'node:test';

import { handleWorkerRequest } from '../src/worker.js';
import {
  createWorkerPasswordHash,
  createWorkerSessionToken
} from '../src/worker-crypto.js';

const SESSION_SECRET = '0123456789abcdef0123456789abcdef';
const ORIGIN_SECRET = 'origin-secret-0123456789abcdef0123456789';
const PASSWORD = 'docs-password';
const PASSWORD_HASH = await createWorkerPasswordHash(PASSWORD, {
  secret: SESSION_SECRET,
  salt: new TextEncoder().encode('0123456789abcdef')
});
const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

function project(overrides = {}) {
  return {
    target: 'https://docs-project.vercel.app',
    deliveryMode: 'proxy',
    proxyProfile: 'fullstack',
    edgeAccess: { mode: 'disabled' },
    originProtection: {
      mode: 'required',
      headerName: 'x-edge-app-gateway-origin',
      secretBinding: 'ORIGIN_SECRET_DOCS'
    },
    allowedMethods: ALL_METHODS,
    cachePolicy: 'assets-only',
    ...overrides
  };
}

function requiredProject(overrides = {}) {
  return project({
    edgeAccess: { mode: 'required', passwordHash: PASSWORD_HASH },
    ...overrides
  });
}

function createEnvironment(route = project(), overrides = {}) {
  return {
    ROUTE_PROJECTS_JSON: JSON.stringify({ 'docs-a7f3': route }),
    ROUTE_SESSION_SECRET: SESSION_SECRET,
    ROUTE_SESSION_TTL_SECONDS: '600',
    ORIGIN_SECRET_DOCS: ORIGIN_SECRET,
    ...overrides
  };
}

function documentHeaders(overrides = {}) {
  return {
    Accept: 'text/html',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    ...overrides
  };
}

test('exposes the namespaced health endpoint without configuration details', async () => {
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/_edge-gateway/health'),
    {}
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    build: '2026-08-21-gateway-v5',
    edge: 'local'
  });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('requires Edge Access only for routes configured as required', async () => {
  const navigation = await handleWorkerRequest(
    new Request('https://data.example.com/guide?lang=zh', {
      headers: documentHeaders()
    }),
    createEnvironment(requiredProject())
  );
  const api = await handleWorkerRequest(
    new Request('https://data.example.com/api/query', {
      headers: { Accept: 'application/json' }
    }),
    createEnvironment(requiredProject())
  );

  assert.equal(navigation.status, 303);
  assert.equal(
    navigation.headers.get('location'),
    '/_edge-gateway/login?next=%2Fguide%3Flang%3Dzh'
  );
  assert.equal(api.status, 401);
  assert.equal((await api.json()).error.code, 'EDGE_AUTHENTICATION_REQUIRED');
});

test('renders a generic login page without exposing route configuration', async () => {
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/_edge-gateway/login?next=%2Fguide'),
    createEnvironment(requiredProject())
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /访问验证/);
  assert.equal(html.includes('docs-a7f3'), false);
  assert.equal(html.includes('docs-project.vercel.app'), false);
  assert.equal(html.includes(PASSWORD_HASH), false);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('authenticates with Origin or Referer and creates an alias-bound secure session', async () => {
  const originResponse = await authenticate(PASSWORD, {
    Origin: 'https://data.example.com'
  });
  const refererResponse = await authenticate(PASSWORD, {
    Referer: 'https://data.example.com/_edge-gateway/login'
  });

  for (const response of [originResponse, refererResponse]) {
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/guide');
    assert.match(response.headers.get('set-cookie'), /^route_session=/);
    assert.match(response.headers.get('set-cookie'), /Path=\//);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /Secure/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }

  const token = readCookie(originResponse.headers.get('set-cookie'), 'route_session');
  const session = await handleWorkerRequest(
    new Request('https://data.example.com/_edge-gateway/session', {
      headers: { Cookie: `route_session=${token}` }
    }),
    createEnvironment(requiredProject())
  );
  assert.deepEqual(await session.json(), { authenticated: true });
});

test('uses the same rejection response for cross-site, incorrect and unresolved login attempts', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);

  try {
    const crossSite = await authenticate(PASSWORD, {
      Origin: 'https://attacker.example'
    });
    const incorrect = await authenticate('wrong-password', {
      Origin: 'https://data.example.com'
    });
    const unresolved = await handleWorkerRequest(
      loginRequest('https://unknown.preview.example.com', 'anything', {
        Origin: 'https://unknown.preview.example.com'
      }),
      createEnvironment(requiredProject(), { ROUTE_BASE_DOMAIN: 'preview.example.com' })
    );

    for (const response of [crossSite, incorrect, unresolved]) {
      assert.equal(response.status, 303);
      assert.equal(
        response.headers.get('location'),
        '/_edge-gateway/login?error=unavailable&next=%2Fguide'
      );
      assert.equal(response.headers.has('set-cookie'), false);
    }
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, [
    'Worker authentication rejected',
    'Worker authentication rejected',
    'Worker authentication rejected'
  ]);
});

test('limits failed logins by client IP and alias without exposing the reason', async () => {
  const store = new Map();
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await handleWorkerRequest(
        loginRequest('https://data.example.com', 'wrong', {
          Origin: 'https://data.example.com',
          'CF-Connecting-IP': '203.0.113.20'
        }),
        createEnvironment(requiredProject()),
        { loginFailureStore: store, now: 1000 }
      );
      assert.equal(response.status, 303);
    }

    const limited = await handleWorkerRequest(
      loginRequest('https://data.example.com', PASSWORD, {
        Origin: 'https://data.example.com',
        'CF-Connecting-IP': '203.0.113.20'
      }),
      createEnvironment(requiredProject()),
      { loginFailureStore: store, now: 1000 }
    );

    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '300');
    assert.match(await limited.text(), /无法验证，请稍后重试/);
  } finally {
    console.warn = originalWarn;
  }
});

test('Edge Access disabled proxies directly without requiring a session secret or redirecting', async () => {
  const environment = createEnvironment();
  delete environment.ROUTE_SESSION_SECRET;
  let called = false;
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/access/login', {
      headers: documentHeaders()
    }),
    environment,
    {
      fetchImpl: async () => {
        called = true;
        return new Response('<h1>Upstream Access Gate</h1>', {
          status: 401,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    }
  );

  assert.equal(called, true);
  assert.equal(response.status, 401);
  assert.equal(await response.text(), '<h1>Upstream Access Gate</h1>');
  assert.equal(response.headers.has('location'), false);
});

test('Edge Access required proxies after login without forwarding the Gateway session', async () => {
  const token = await createWorkerSessionToken('docs-a7f3', SESSION_SECRET, {
    ttlSeconds: 600
  });
  let forwardedCookie = '';
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/private', {
      headers: {
        Cookie: `route_session=${token}; app_session=application-private`
      }
    }),
    createEnvironment(requiredProject()),
    {
      fetchImpl: async (url, options) => {
        forwardedCookie = options.headers.get('cookie');
        return new Response('protected content', {
          headers: { 'Content-Type': 'text/plain' }
        });
      }
    }
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'protected content');
  assert.equal(forwardedCookie, 'app_session=application-private');
});

test('completes an upstream Access Gate login and logout flow with rewritten origins', async () => {
  const accessProject = project({ requestOriginPolicy: 'rewrite-to-upstream' });
  const upstreamCalls = [];
  const fetchImpl = async (url, options) => {
    const body = options.body ? await new Response(options.body).text() : '';
    const call = {
      url: url.toString(),
      method: options.method,
      origin: options.headers.get('origin'),
      referer: options.headers.get('referer'),
      forwardedHost: options.headers.get('x-forwarded-host'),
      cookie: options.headers.get('cookie'),
      body
    };
    upstreamCalls.push(call);

    if (call.origin !== url.origin) {
      return new Response(JSON.stringify({ error: { code: 'ORIGIN_NOT_ALLOWED' } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/api/auth/login') {
      return new Response(JSON.stringify({ authenticated: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'app_access=upstream-session; Path=/; HttpOnly; Secure; SameSite=Lax'
        }
      });
    }

    if (url.pathname === '/api/auth/logout' && call.cookie === 'app_access=upstream-session') {
      return new Response(null, {
        status: 204,
        headers: {
          'Set-Cookie': 'app_access=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
        }
      });
    }

    return new Response('Unauthorized', { status: 401 });
  };

  const login = await handleWorkerRequest(
    new Request('https://data.example.com/api/auth/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://data.example.com',
        Referer: 'https://data.example.com/access?next=%2Fdashboard'
      },
      body: JSON.stringify({ password: 'application-password' })
    }),
    createEnvironment(accessProject),
    { fetchImpl }
  );
  const loginCookie = login.headers.getSetCookie()[0];

  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), { authenticated: true });
  assert.match(loginCookie, /^app_access=upstream-session/);

  const logout = await handleWorkerRequest(
    new Request('https://data.example.com/api/auth/logout', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Cookie: 'app_access=upstream-session',
        Origin: 'https://data.example.com',
        Referer: 'https://data.example.com/settings/security'
      }
    }),
    createEnvironment(accessProject),
    { fetchImpl }
  );

  assert.equal(logout.status, 204);
  assert.match(logout.headers.getSetCookie()[0], /^app_access=;/);
  assert.match(logout.headers.getSetCookie()[0], /Max-Age=0/);
  assert.deepEqual(upstreamCalls, [
    {
      url: 'https://docs-project.vercel.app/api/auth/login',
      method: 'POST',
      origin: 'https://docs-project.vercel.app',
      referer: 'https://docs-project.vercel.app/access?next=%2Fdashboard',
      forwardedHost: 'data.example.com',
      cookie: null,
      body: JSON.stringify({ password: 'application-password' })
    },
    {
      url: 'https://docs-project.vercel.app/api/auth/logout',
      method: 'POST',
      origin: 'https://docs-project.vercel.app',
      referer: 'https://docs-project.vercel.app/settings/security',
      forwardedHost: 'data.example.com',
      cookie: 'app_access=upstream-session',
      body: ''
    }
  ]);
});

test('rejects cross-site browser origins before contacting an upstream Access Gate', async () => {
  let fetchCalled = false;
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
        Referer: 'https://attacker.example/phishing'
      },
      body: JSON.stringify({ password: 'stolen' })
    }),
    createEnvironment(project({ requestOriginPolicy: 'rewrite-to-upstream' })),
    {
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response('unsafe');
      }
    }
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'EDGE_ORIGIN_NOT_ALLOWED',
      message: '请求来源不受信任'
    }
  });
  assert.equal(fetchCalled, false);
});

test('allows originless API clients while retaining the actual forwarded host', async () => {
  let seenHeaders;
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/api/server-job', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer server-client',
        'Content-Type': 'application/json'
      },
      body: '{}'
    }),
    createEnvironment(project({ requestOriginPolicy: 'rewrite-to-upstream' })),
    {
      fetchImpl: async (url, options) => {
        seenHeaders = options.headers;
        return new Response('{"ok":true}', {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  );

  assert.equal(response.status, 200);
  assert.equal(seenHeaders.has('origin'), false);
  assert.equal(seenHeaders.get('x-forwarded-host'), 'data.example.com');
  assert.equal(seenHeaders.get('authorization'), 'Bearer server-client');
});

test('proxies POST bodies and application authentication data without reading or rewriting them', async () => {
  const payload = JSON.stringify({ query: 'select * from data', nested: { ok: true } });
  let seen;
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/api/query?format=json', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer app-token',
        Connection: 'keep-alive, x-client-private',
        'Content-Type': 'application/json',
        Cookie: 'route_session=gateway; app_session=upstream; theme=dark',
        'X-Client-Private': 'remove',
        'X-Edge-App-Gateway-Origin': 'forged'
      },
      body: payload
    }),
    createEnvironment(),
    {
      fetchImpl: async (url, options) => {
        seen = {
          url: url.toString(),
          method: options.method,
          headers: options.headers,
          body: await new Response(options.body).text()
        };
        return new Response('{"ok":true}', {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  );

  assert.equal(seen.url, 'https://docs-project.vercel.app/api/query?format=json');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body, payload);
  assert.equal(seen.headers.get('content-type'), 'application/json');
  assert.equal(seen.headers.get('accept'), 'application/json');
  assert.equal(seen.headers.get('authorization'), 'Bearer app-token');
  assert.equal(seen.headers.get('cookie'), 'app_session=upstream; theme=dark');
  assert.equal(seen.headers.get('x-edge-app-gateway-origin'), ORIGIN_SECRET);
  assert.equal(seen.headers.has('connection'), false);
  assert.equal(seen.headers.has('x-client-private'), false);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('supports PUT, PATCH and DELETE request bodies in the fullstack profile', async () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    let forwardedBody = '';
    const response = await handleWorkerRequest(
      new Request('https://data.example.com/api/item', {
        method,
        headers: { 'Content-Type': 'text/plain' },
        body: `${method}-body`
      }),
      createEnvironment(),
      {
        fetchImpl: async (url, options) => {
          forwardedBody = await new Response(options.body).text();
          return new Response(null, { status: 204 });
        }
      }
    );

    assert.equal(response.status, 204);
    assert.equal(forwardedBody, `${method}-body`);
  }
});

test('does not attach request bodies to GET or HEAD and forwards OPTIONS', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ method: options.method, hasBody: Object.hasOwn(options, 'body') });
    return new Response(null, { status: options.method === 'OPTIONS' ? 204 : 200 });
  };

  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const response = await handleWorkerRequest(
      new Request('https://data.example.com/resource', { method }),
      createEnvironment(),
      { fetchImpl }
    );
    assert.equal(response.status, method === 'OPTIONS' ? 204 : 200);
  }

  assert.deepEqual(calls, [
    { method: 'GET', hasBody: false },
    { method: 'HEAD', hasBody: false },
    { method: 'OPTIONS', hasBody: true }
  ]);
});

test('returns 405 with the configured canonical Allow header', async () => {
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/api/query', { method: 'DELETE' }),
    createEnvironment(project({ allowedMethods: ['OPTIONS', 'POST', 'GET', 'HEAD'] }))
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD, POST, OPTIONS');
  assert.equal((await response.json()).error.code, 'EDGE_METHOD_NOT_ALLOWED');
});

test('preserves application cookies, multiple Set-Cookie values and redirect headers', async () => {
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/old'),
    createEnvironment(project({ cookieDomainPolicy: 'rewrite' })),
    {
      fetchImpl: async () => {
        const headers = new Headers({
          'Cache-Control': 'private, max-age=10',
          'Content-Type': 'text/plain',
          Location: '/new'
        });
        headers.append('Set-Cookie', 'app_session=one; Path=/; HttpOnly');
        headers.append(
          'Set-Cookie',
          'preference=dark; Domain=docs-project.vercel.app; Path=/; SameSite=Lax'
        );
        return new Response(null, { status: 302, headers });
      }
    }
  );
  const cookies = response.headers.getSetCookie();

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://data.example.com/new');
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0], 'app_session=one; Path=/; HttpOnly');
  assert.match(cookies[1], /Domain=data\.example\.com/i);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('passes upstream API error status, type, headers and body through unchanged', async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 504]) {
    const body = JSON.stringify({ upstream: true, status });
    const response = await handleWorkerRequest(
      new Request('https://data.example.com/api/query', {
        headers: { Accept: 'application/json' }
      }),
      createEnvironment(),
      {
        fetchImpl: async () => new Response(body, {
          status,
          headers: {
            'Content-Type': 'application/json',
            'X-Upstream-Error': 'preserved'
          }
        })
      }
    );

    assert.equal(response.status, status);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-upstream-error'), 'preserved');
    assert.equal(await response.text(), body);
  }
});

test('streams the first NDJSON chunk before the upstream response closes', async () => {
  let streamController;
  let upstreamClosed = false;
  const upstreamBody = new ReadableStream({
    start(controller) {
      streamController = controller;
    }
  });
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/any/streaming-endpoint', {
      method: 'POST',
      headers: {
        Accept: 'application/x-ndjson',
        'Content-Type': 'application/json'
      },
      body: '{}'
    }),
    createEnvironment(),
    {
      fetchImpl: async () => new Response(upstreamBody, {
        headers: { 'Content-Type': 'application/x-ndjson' }
      })
    }
  );
  const reader = response.body.getReader();
  const firstChunkPromise = reader.read();
  streamController.enqueue(new TextEncoder().encode('{"row":1}\n'));
  const firstChunk = await Promise.race([
    firstChunkPromise,
    new Promise((resolve, reject) => setTimeout(
      () => reject(new Error('first chunk was buffered until stream completion')),
      250
    ))
  ]);

  assert.equal(new TextDecoder().decode(firstChunk.value), '{"row":1}\n');
  assert.equal(firstChunk.done, false);
  assert.equal(upstreamClosed, false);
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
  assert.equal(response.headers.get('cache-control'), 'no-store');

  upstreamClosed = true;
  streamController.close();
  await reader.read();
});

test('uses structured errors for connection failures except real document navigations', async () => {
  const originalError = console.error;
  console.error = () => {};

  try {
    const fetchImpl = async () => {
      throw new TypeError('network failure with private detail');
    };
    const api = await handleWorkerRequest(
      new Request('https://data.example.com/api/query', {
        headers: { Accept: 'application/json' }
      }),
      createEnvironment(),
      { fetchImpl }
    );
    const navigation = await handleWorkerRequest(
      new Request('https://data.example.com/dashboard', {
        headers: documentHeaders()
      }),
      createEnvironment(),
      { fetchImpl }
    );
    const htmlFetch = await handleWorkerRequest(
      new Request('https://data.example.com/dashboard', {
        headers: { Accept: 'text/html' }
      }),
      createEnvironment(),
      { fetchImpl }
    );

    assert.equal(api.status, 502);
    assert.deepEqual(await api.json(), {
      error: {
        code: 'EDGE_UPSTREAM_UNAVAILABLE',
        message: '上游服务暂时不可用'
      }
    });
    assert.equal(navigation.status, 502);
    assert.match(navigation.headers.get('content-type'), /^text\/html/);
    assert.match(await navigation.text(), /暂时不可用/);
    assert.equal(htmlFetch.status, 502);
    assert.match(htmlFetch.headers.get('content-type'), /^application\/json/);
  } finally {
    console.error = originalError;
  }
});

test('applies assets-only caching without caching API, stream or authenticated traffic', async () => {
  const fetchImpl = async url => {
    const contentType = url.pathname.endsWith('.css') ? 'text/css' : 'application/x-ndjson';
    return new Response('body', { headers: { 'Content-Type': contentType } });
  };
  const staticAsset = await handleWorkerRequest(
    new Request('https://data.example.com/assets/app.css'),
    createEnvironment(),
    { fetchImpl }
  );
  const apiStream = await handleWorkerRequest(
    new Request('https://data.example.com/api/query'),
    createEnvironment(),
    { fetchImpl }
  );
  const authorizedAsset = await handleWorkerRequest(
    new Request('https://data.example.com/assets/app.css', {
      headers: { Authorization: 'Bearer app-token' }
    }),
    createEnvironment(),
    { fetchImpl }
  );
  const cookieAsset = await handleWorkerRequest(
    new Request('https://data.example.com/assets/app.css', {
      headers: { Cookie: 'app_session=private' }
    }),
    createEnvironment(),
    { fetchImpl }
  );

  assert.equal(staticAsset.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(apiStream.headers.get('cache-control'), 'no-store');
  assert.equal(authorizedAsset.headers.get('cache-control'), 'no-store');
  assert.equal(cookieAsset.headers.get('cache-control'), 'no-store');
});

test('fails safely when an origin secret binding is absent', async () => {
  const environment = createEnvironment();
  delete environment.ORIGIN_SECRET_DOCS;
  let fetchCalled = false;
  const originalError = console.error;
  console.error = () => {};

  try {
    const response = await handleWorkerRequest(
      new Request('https://data.example.com/'),
      environment,
      {
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response('unsafe');
        }
      }
    );

    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'EDGE_CONFIGURATION_ERROR');
    assert.equal(fetchCalled, false);
  } finally {
    console.error = originalError;
  }
});

test('logs out through the gateway namespace and clears only the gateway cookie', async () => {
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/_edge-gateway/logout', {
      method: 'POST',
      headers: { Origin: 'https://data.example.com' }
    }),
    createEnvironment(requiredProject())
  );

  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /^route_session=;/);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('redirect delivery is used only when explicitly configured', async () => {
  const redirectProject = project({
    deliveryMode: 'redirect',
    originProtection: { mode: 'disabled' },
    allowedMethods: ['GET', 'HEAD']
  });
  const response = await handleWorkerRequest(
    new Request('https://data.example.com/guide?lang=zh'),
    createEnvironment(redirectProject)
  );

  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get('location'),
    'https://docs-project.vercel.app/guide?lang=zh'
  );
});

async function authenticate(password, headers) {
  return handleWorkerRequest(
    loginRequest('https://data.example.com', password, headers),
    createEnvironment(requiredProject()),
    { loginFailureStore: new Map() }
  );
}

function loginRequest(origin, password, headers) {
  return new Request(`${origin}/_edge-gateway/login?next=%2Fguide`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers
    },
    body: new URLSearchParams({ password, next: '/guide' })
  });
}

function readCookie(rawCookie, name) {
  for (const part of String(rawCookie || '').split(';')) {
    const [cookieName, value] = part.trim().split('=');

    if (cookieName === name) {
      return value;
    }
  }

  return '';
}
