import { buildUpstreamHeaders, buildUpstreamUrl, rewriteLocation, sanitizeNextPath } from '../lib/proxy-utils.js';
import { isValidRouteAlias, parseRouteProjects } from '../lib/route-config.js';
import {
  createWorkerSessionToken,
  parseWorkerSessionTtl,
  verifyWorkerPassword,
  verifyWorkerSessionToken
} from './worker-crypto.js';

const SESSION_COOKIE_NAME = 'route_session';
const LOGIN_PATH = '/__route/login';
const LOGIN_SCRIPT_PATH = '/__route/login.js';
const AUTH_PATH = '/__route/auth';
const SUCCESS_PATH = '/__route/success';
const SUCCESS_SCRIPT_PATH = '/__route/success.js';
const UNAVAILABLE_PATH = '/__route/unavailable';
const HEALTH_PATH = '/__route/health';
const WORKER_BUILD_ID = '2026-08-03-route-v2';
const DUMMY_PASSWORD_HASH = 'hmac-sha256$ZHVtbXktcm91dGUtc2FsdA$7VCcQ_9KLIdA9rWiYngmq7WGpRLkQkrmKULgLmqv_5M';
const REWRITABLE_CONTENT_TYPES = new Set([
  'application/json',
  'application/manifest+json',
  'application/xml',
  'image/svg+xml',
  'text/css',
  'text/html',
  'text/xml'
]);
const RESPONSE_HEADER_ALLOWLIST = [
  'accept-ranges',
  'content-disposition',
  'content-language',
  'content-range',
  'content-security-policy',
  'content-type',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'etag',
  'last-modified',
  'permissions-policy',
  'service-worker-allowed',
  'x-frame-options'
];

export default {
  fetch(request, env) {
    return handleWorkerRequest(request, env);
  }
};

export async function handleWorkerRequest(request, env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const url = new URL(request.url);

  if (url.pathname === HEALTH_PATH) {
    return jsonResponse({
      ok: true,
      build: WORKER_BUILD_ID,
      edge: request.cf?.colo || 'local'
    });
  }

  let projects;
  let alias;
  let sessionTtl;

  try {
    projects = parseRouteProjects(env.ROUTE_PROJECTS_JSON);
    alias = resolveWorkerAlias(url.hostname, env, projects);
    sessionTtl = parseWorkerSessionTtl(env.ROUTE_SESSION_TTL_SECONDS);
  } catch (error) {
    console.error('Worker configuration is invalid:', error.name);
    return acceptsHtml(request) ? unavailableResponse() : textResponse('Not Found', 404);
  }

  if (url.pathname === LOGIN_PATH && request.method === 'GET') {
    return loginResponse(url);
  }

  if (url.pathname === LOGIN_SCRIPT_PATH && request.method === 'GET') {
    return scriptResponse(LOGIN_SCRIPT);
  }

  if (url.pathname === SUCCESS_PATH && request.method === 'GET') {
    return successResponse();
  }

  if (url.pathname === SUCCESS_SCRIPT_PATH && request.method === 'GET') {
    return scriptResponse(SUCCESS_SCRIPT);
  }

  if (url.pathname === UNAVAILABLE_PATH && request.method === 'GET') {
    return unavailableResponse();
  }

  const project = alias ? projects.get(alias) : null;

  if (url.pathname === AUTH_PATH) {
    return authenticateRequest(request, url, alias, project, env, sessionTtl, now);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' }
    });
  }

  let authenticated = false;

  try {
    authenticated = alias && await verifyWorkerSessionToken(
      readCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME),
      alias,
      env.ROUTE_SESSION_SECRET,
      { now }
    );
  } catch (error) {
    console.error('Worker session configuration is invalid:', error.name);
    return unavailableForRequest(request);
  }

  if (!authenticated) {
    if (acceptsHtml(request)) {
      const loginUrl = new URL(LOGIN_PATH, url.origin);
      loginUrl.searchParams.set('next', sanitizeNextPath(`${url.pathname}${url.search}`));
      return redirectResponse(`${loginUrl.pathname}${loginUrl.search}`);
    }

    return textResponse('Authentication required', 401);
  }

  if (!project) {
    return unavailableForRequest(request);
  }

  return proxyRequest(request, url, project, fetchImpl);
}

async function authenticateRequest(request, url, alias, project, env, sessionTtl, now) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST' }
    });
  }

  if (!isTrustedAuthenticationOrigin(request, url)) {
    return rejectAuthentication('/', 'origin-mismatch');
  }

  if (Number(request.headers.get('content-length') || 0) > 4096) {
    return rejectAuthentication('/', 'body-too-large');
  }

  let form;

  try {
    form = await request.formData();
  } catch {
    return rejectAuthentication('/', 'invalid-form');
  }

  const password = form.get('password');
  const nextPath = sanitizeNextPath(form.get('next'));
  let passwordMatches;

  try {
    passwordMatches = await verifyWorkerPassword(
      password,
      project?.passwordHash ?? DUMMY_PASSWORD_HASH,
      env.ROUTE_SESSION_SECRET
    );
  } catch (error) {
    console.error(`Worker project password configuration is invalid: ${error.message || error.name}`);
    return redirectToLogin(nextPath);
  }

  if (!alias) {
    return rejectAuthentication(nextPath, 'route-not-resolved');
  }

  if (!project) {
    return rejectAuthentication(nextPath, 'project-not-found');
  }

  if (!passwordMatches) {
    return rejectAuthentication(nextPath, 'password-mismatch');
  }

  let token;

  try {
    token = await createWorkerSessionToken(alias, env.ROUTE_SESSION_SECRET, {
      now,
      ttlSeconds: sessionTtl
    });
  } catch (error) {
    console.error('Worker session configuration is invalid:', error.name);
    return redirectToLogin(nextPath);
  }

  const successUrl = new URL(SUCCESS_PATH, url.origin);
  successUrl.searchParams.set('next', nextPath);
  const headers = new Headers({
    'Cache-Control': 'no-store',
    Location: `${successUrl.pathname}${successUrl.search}`,
    'Set-Cookie': buildSessionCookie(token, sessionTtl)
  });
  return new Response(null, { status: 303, headers });
}

function isTrustedAuthenticationOrigin(request, url) {
  const origin = request.headers.get('origin');

  if (origin === url.origin) {
    return true;
  }

  const fetchSite = String(request.headers.get('sec-fetch-site') || '').toLowerCase();
  return !origin && fetchSite === 'same-origin';
}

async function proxyRequest(request, requestUrl, project, fetchImpl) {
  let upstreamUrl;

  try {
    upstreamUrl = buildUpstreamUrl(
      project.target,
      requestUrl.pathname,
      requestUrl.searchParams.toString()
    );
  } catch {
    return unavailableForRequest(request);
  }

  let upstreamResponse;

  try {
    upstreamResponse = await fetchImpl(upstreamUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request.headers),
      redirect: 'manual'
    });
  } catch (error) {
    console.error('Worker upstream request failed:', error.name);
    return unavailableForRequest(request);
  }

  if (upstreamResponse.status >= 400 && acceptsHtml(request)) {
    return redirectResponse(UNAVAILABLE_PATH);
  }

  const headers = copyResponseHeaders(upstreamResponse.headers);
  const location = rewriteLocation(
    upstreamResponse.headers.get('location'),
    upstreamUrl,
    requestUrl.origin
  );

  if (location) {
    headers.set('Location', location);
  }

  const shouldRewrite = project.rewriteOrigins && shouldRewriteText(
    upstreamResponse,
    request.headers.has('range')
  );

  if (shouldRewrite) {
    headers.delete('etag');
    const contentSecurityPolicy = headers.get('content-security-policy');

    if (contentSecurityPolicy) {
      headers.set(
        'content-security-policy',
        rewriteText(contentSecurityPolicy, upstreamUrl.origin, requestUrl.origin)
      );
    }
  }

  if (request.method === 'HEAD' || !upstreamResponse.body) {
    return new Response(null, {
      status: upstreamResponse.status,
      headers
    });
  }

  const body = shouldRewrite
    ? upstreamResponse.body.pipeThrough(createOriginRewriteStream(
      upstreamUrl.origin,
      requestUrl.origin
    ))
    : upstreamResponse.body;

  return new Response(body, {
    status: upstreamResponse.status,
    headers
  });
}

function resolveWorkerAlias(hostname, env, projects) {
  const host = hostname.toLowerCase();
  const baseDomain = String(env.ROUTE_BASE_DOMAIN || '').trim().toLowerCase();

  if (baseDomain) {
    if (host.endsWith(`.${baseDomain}`)) {
      const alias = host.slice(0, -(baseDomain.length + 1));
      return isValidRouteAlias(alias) ? alias : null;
    }

    return null;
  }

  return projects.size === 1 ? projects.keys().next().value : null;
}

function loginResponse(url) {
  const showError = url.searchParams.get('error') === 'unavailable';
  const nextPath = sanitizeNextPath(url.searchParams.get('next'));
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>访问验证</title><style>${PAGE_STYLES}</style>
<script src="${LOGIN_SCRIPT_PATH}" type="module"></script></head><body><main class="shell"><section class="card" aria-labelledby="page-title">
<div class="lock" aria-hidden="true"></div><h1 id="page-title">访问验证</h1><p class="subtitle">请输入密码后继续</p>
<div class="message" id="message" role="alert"${showError ? '' : ' hidden'}><span class="message-icon" aria-hidden="true">!</span><strong>无法访问</strong></div>
<form action="${AUTH_PATH}" method="post" id="route-form"><input name="next" type="hidden" value="${escapeHtml(nextPath)}">
<label class="sr-only" for="password">访问密码</label><input id="password" name="password" type="password" maxlength="256" autocomplete="current-password" placeholder="访问密码" autofocus required>
<button type="submit" id="submit-button">继续</button></form></section></main></body></html>`;
  return htmlResponse(html);
}

function successResponse() {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>验证通过</title><style>${PAGE_STYLES}</style>
<script src="${SUCCESS_SCRIPT_PATH}" type="module"></script></head><body><main class="shell"><section class="card success" aria-live="polite">
<div class="loader" aria-hidden="true"></div><h1>验证通过</h1><p class="subtitle">正在进入</p>
</section></main></body></html>`;
  return htmlResponse(html);
}

function unavailableResponse() {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>无法访问</title><style>${PAGE_STYLES}</style></head>
<body><main class="shell"><section class="card unavailable" role="alert"><div class="unavailable-mark" aria-hidden="true">!</div><h1>无法访问</h1></section></main></body></html>`;
  return htmlResponse(html);
}

function createOriginRewriteStream(upstreamOrigin, proxyOrigin) {
  const replacements = buildReplacements(upstreamOrigin, proxyOrigin);
  const maximumTargetLength = Math.max(...replacements.map(([target]) => target.length));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = '';

  return new TransformStream({
    transform(chunk, controller) {
      const text = carry + decoder.decode(chunk, { stream: true });
      const rewritten = applyReplacements(text, replacements);
      const retainedLength = Math.min(maximumTargetLength - 1, rewritten.length);
      const emitLength = rewritten.length - retainedLength;
      carry = rewritten.slice(emitLength);
      controller.enqueue(encoder.encode(rewritten.slice(0, emitLength)));
    },
    flush(controller) {
      controller.enqueue(encoder.encode(
        applyReplacements(carry + decoder.decode(), replacements)
      ));
    }
  });
}

function rewriteText(text, upstreamOrigin, proxyOrigin) {
  return applyReplacements(text, buildReplacements(upstreamOrigin, proxyOrigin));
}

function buildReplacements(upstreamOrigin, proxyOrigin) {
  return [
    [upstreamOrigin, proxyOrigin],
    [upstreamOrigin.replaceAll('/', '\\/'), proxyOrigin.replaceAll('/', '\\/')]
  ];
}

function applyReplacements(text, replacements) {
  let rewritten = text;

  for (const [target, replacement] of replacements) {
    rewritten = rewritten.replaceAll(target, replacement);
  }

  return rewritten;
}

function shouldRewriteText(response, hasRangeRequest) {
  const contentType = String(response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return response.status === 200 && !hasRangeRequest && REWRITABLE_CONTENT_TYPES.has(contentType);
}

function copyResponseHeaders(upstreamHeaders) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  });

  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = upstreamHeaders.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  return headers;
}

function readCookie(rawCookie, name) {
  for (const part of String(rawCookie || '').split(';')) {
    const separator = part.indexOf('=');

    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }

  return '';
}

function buildSessionCookie(token, ttlSeconds) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}

function redirectToLogin(nextPath) {
  const query = new URLSearchParams({
    error: 'unavailable',
    next: sanitizeNextPath(nextPath)
  });
  return redirectResponse(`${LOGIN_PATH}?${query}`);
}

function rejectAuthentication(nextPath, reason) {
  console.warn(`Worker authentication rejected: ${reason}`);
  return redirectToLogin(nextPath);
}

function unavailableForRequest(request) {
  return acceptsHtml(request)
    ? redirectResponse(UNAVAILABLE_PATH)
    : textResponse('Not Found', 404);
}

function redirectResponse(location) {
  return new Response(null, {
    status: 303,
    headers: {
      'Cache-Control': 'no-store',
      Location: location
    }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    }
  });
}

function scriptResponse(script) {
  return new Response(script, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/javascript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function acceptsHtml(request) {
  const accept = request.headers.get('accept') || '';
  return !accept || accept.includes('text/html');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const LOGIN_SCRIPT = `const form=document.querySelector('#route-form');const message=document.querySelector('#message');const password=document.querySelector('#password');const button=document.querySelector('#submit-button');form.addEventListener('submit',()=>{message.hidden=true;password.readOnly=true;button.disabled=true;button.textContent='验证中';});`;
const SUCCESS_SCRIPT = `const parameters=new URLSearchParams(window.location.search);const requested=parameters.get('next')||'/';const next=requested.startsWith('/')&&!requested.startsWith('//')&&!requested.startsWith('/__route/')?requested:'/';window.setTimeout(()=>window.location.replace(next),900);`;
const PAGE_STYLES = `:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fa;font-synthesis:none}*{box-sizing:border-box}body{min-width:320px;min-height:100vh;margin:0;background:#f5f7fa}.shell{display:grid;min-height:100vh;place-items:center;padding:20px}.card{width:min(100%,380px);padding:36px;border:1px solid #e4e9f0;border-radius:18px;background:#fff;box-shadow:0 18px 50px rgb(15 23 42/8%)}.lock{position:relative;width:42px;height:36px;margin:0 auto 24px;border-radius:10px;background:#172033}.lock:before{position:absolute;top:-16px;left:9px;width:20px;height:22px;border:3px solid #172033;border-bottom:0;border-radius:12px 12px 0 0;content:""}.lock:after{position:absolute;top:14px;left:19px;width:4px;height:9px;border-radius:4px;background:#fff;content:""}h1{margin:0;font-size:26px;line-height:1.25;text-align:center;letter-spacing:-.02em}.subtitle{margin:8px 0 26px;color:#7b8494;font-size:14px;text-align:center}.message{display:flex;gap:11px;align-items:center;margin:0 0 16px;padding:12px;border:1px solid #fecaca;border-radius:10px;color:#991b1b;background:#fff5f5}.message[hidden]{display:none}.message-icon{display:grid;flex:0 0 28px;width:28px;height:28px;place-items:center;border-radius:50%;color:#fff;background:#dc2626;font-weight:800}.message strong{font-size:14px}form{display:grid;gap:12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}input,button{width:100%;height:48px;border-radius:10px;font:inherit}input{padding:0 14px;border:1px solid #cfd6e1;outline:none;color:#172033;background:#fff}input:focus{border-color:#172033;box-shadow:0 0 0 3px rgb(23 32 51/10%)}button{border:0;color:#fff;background:#172033;font-weight:700;cursor:pointer}button:hover:not(:disabled){background:#293855}button:disabled{cursor:wait;opacity:.78}.success,.unavailable{text-align:center}.loader{width:46px;height:46px;margin:0 auto 24px;border:4px solid #e4e9f0;border-top-color:#172033;border-radius:50%;animation:spin 750ms linear infinite}.success .subtitle{margin-bottom:0}.unavailable-mark{display:grid;width:46px;height:46px;margin:0 auto 24px;place-items:center;border-radius:50%;color:#fff;background:#dc2626;font-size:24px;font-weight:800}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:480px){.card{padding:32px 22px}}`;
