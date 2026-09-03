import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  copyUpstreamResponseHeaders,
  getSetCookieValues,
  RequestOriginPolicyError,
  rewriteLocation,
  rewriteSetCookieDomain,
  sanitizeNextPath
} from '../lib/proxy-utils.js';
import {
  getProjectHostnameAlias,
  isValidRouteAlias,
  parseRouteProjects,
  resolveUnifiedEntryAlias
} from '../lib/route-config.js';
import {
  createEntryHandoffToken,
  createEntrySessionToken,
  createWorkerSessionToken,
  parseWorkerSessionTtl,
  verifyEntryHandoffToken,
  verifyEntrySessionToken,
  verifyWorkerPassword,
  verifyWorkerSessionToken
} from './worker-crypto.js';

export { EntryTicketRedeemer } from './entry-ticket-redeemer.js';

const SESSION_COOKIE_NAME = 'route_session';
const ENTRY_SESSION_COOKIE_NAME = 'entry_session';
const GATEWAY_PREFIX = '/_edge-gateway/';
const LOGIN_PATH = `${GATEWAY_PREFIX}login`;
const LOGOUT_PATH = `${GATEWAY_PREFIX}logout`;
const SESSION_PATH = `${GATEWAY_PREFIX}session`;
const ENTRY_LAUNCH_PATH = `${GATEWAY_PREFIX}launch`;
const ENTRY_ACCEPT_PATH = `${GATEWAY_PREFIX}entry`;
const HEALTH_PATH = `${GATEWAY_PREFIX}health`;
const WORKER_BUILD_ID = '2026-08-27-gateway-v9';
const DUMMY_PASSWORD_HASH = 'hmac-sha256$ZHVtbXktcm91dGUtc2FsdA$7VCcQ_9KLIdA9rWiYngmq7WGpRLkQkrmKULgLmqv_5M';
const DUMMY_SESSION_SECRET = 'dummy-session-secret-for-unresolved-routes';
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const STATIC_CACHE_MAX_AGE = 3600;
const loginFailureStore = new Map();
const STATIC_ASSET_EXTENSIONS = new Set([
  'avif', 'css', 'eot', 'gif', 'ico', 'jpeg', 'jpg', 'js', 'map', 'mjs', 'mp3',
  'mp4', 'ogg', 'otf', 'pdf', 'png', 'svg', 'ttf', 'wasm', 'webm', 'webp', 'woff', 'woff2'
]);
const STREAMING_CONTENT_TYPES = new Set([
  'application/json-seq',
  'application/ndjson',
  'application/x-ndjson',
  'text/event-stream'
]);

export default {
  fetch(request, env) {
    return handleWorkerRequest(request, env);
  }
};

export async function handleWorkerRequest(request, env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const url = new URL(request.url);

  let projects;
  let alias;

  try {
    projects = parseRouteProjects(env.ROUTE_PROJECTS_JSON);
    alias = resolveWorkerAlias(url.hostname, env, projects);
  } catch (error) {
    console.error('Worker configuration is invalid:', error.name);
    return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
  }

  const project = alias ? projects.get(alias) : null;

  if (url.pathname === HEALTH_PATH) {
    if (!project || project.entryAccess.mode === 'required') {
      return entryConcealmentResponse(request);
    }

    return jsonResponse({
      ok: true,
      build: WORKER_BUILD_ID,
      edge: request.cf?.colo || 'local'
    });
  }

  if (url.pathname.startsWith(GATEWAY_PREFIX)) {
    return handleGatewayRequest(request, url, alias, project, env, {
      ...options,
      projects,
      now
    });
  }

  if (!project) {
    return gatewayError('EDGE_ROUTE_NOT_FOUND', '请求的入口不可用', 404);
  }

  if (project.entryAccess.mode === 'required') {
    const authorized = await verifyEntrySession(request, alias, project, env, now);

    if (authorized === null) {
      return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
    }

    if (!authorized) {
      return entryConcealmentResponse(request);
    }
  }

  if (!project.allowedMethods.includes(request.method)) {
    return methodNotAllowed(project.allowedMethods);
  }

  if (project.edgeAccess.mode === 'required') {
    const authenticated = await verifyGatewaySession(request, alias, env, now);

    if (authenticated === null) {
      return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
    }

    if (!authenticated) {
      if (isDocumentNavigation(request)) {
        const loginUrl = new URL(LOGIN_PATH, url.origin);
        loginUrl.searchParams.set('next', sanitizeNextPath(`${url.pathname}${url.search}`));
        return redirectResponse(`${loginUrl.pathname}${loginUrl.search}`);
      }

      return gatewayError('EDGE_AUTHENTICATION_REQUIRED', '需要通过边缘访问验证', 401);
    }
  }

  if (project.deliveryMode === 'redirect') {
    return redirectToUpstream(url, project);
  }

  return proxyRequest(request, url, project, env, fetchImpl);
}

async function handleGatewayRequest(request, url, alias, project, env, options) {
  if (project?.entryAccess.mode === 'required' && url.pathname !== ENTRY_ACCEPT_PATH) {
    const authorized = await verifyEntrySession(request, alias, project, env, options.now);

    if (authorized === null) {
      return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
    }

    if (!authorized) {
      return entryConcealmentResponse(request);
    }
  }

  if (url.pathname === ENTRY_LAUNCH_PATH) {
    if (request.method !== 'GET') {
      return entryConcealmentResponse(request);
    }

    return createEntryHandoffResponse(request, url, alias, project, env, options);
  }

  if (url.pathname === ENTRY_ACCEPT_PATH) {
    if (request.method !== 'GET') {
      return entryConcealmentResponse(request);
    }

    return acceptEntryHandoff(request, url, alias, project, env, options);
  }

  if (url.pathname === LOGIN_PATH) {
    if (request.method === 'GET') {
      return loginResponse(url);
    }

    if (request.method === 'POST') {
      return authenticateRequest(request, url, alias, project, env, options);
    }

    return methodNotAllowed(['GET', 'POST']);
  }

  if (url.pathname === LOGOUT_PATH) {
    if (request.method !== 'POST') {
      return methodNotAllowed(['POST']);
    }

    if (!isTrustedAuthenticationOrigin(request, url)) {
      return gatewayError('EDGE_REQUEST_REJECTED', '请求未通过安全校验', 403);
    }

    return new Response(null, {
      status: 204,
      headers: {
        'Cache-Control': 'private, no-store',
        'Set-Cookie': clearSessionCookie()
      }
    });
  }

  if (url.pathname === SESSION_PATH) {
    if (request.method !== 'GET') {
      return methodNotAllowed(['GET']);
    }

    let authenticated = false;

    if (alias && project?.edgeAccess.mode === 'required') {
      const result = await verifyGatewaySession(request, alias, env, options.now);

      if (result === null) {
        return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
      }

      authenticated = result;
    }

    return jsonResponse({ authenticated });
  }

  return gatewayError('EDGE_GATEWAY_ENDPOINT_NOT_FOUND', '网关接口不存在', 404);
}

async function createEntryHandoffResponse(request, url, alias, project, env, options) {
  if (
    !alias ||
    !project ||
    project.entryAccess.mode !== 'disabled' ||
    !isTrustedEntryLaunch(request, url)
  ) {
    return entryConcealmentResponse(request);
  }

  if (project.edgeAccess.mode === 'required') {
    const authenticated = await verifyGatewaySession(request, alias, env, options.now);
    if (authenticated === null) {
      return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
    }
    if (!authenticated) {
      return entryConcealmentResponse(request);
    }
  }

  const targetAlias = resolveEntryTargetAlias(
    url.searchParams.get('target'),
    env,
    options.projects
  );
  const targetProject = targetAlias ? options.projects.get(targetAlias) : null;

  if (
    !targetProject ||
    targetProject.entryAccess.mode !== 'required' ||
    targetProject.entryAccess.entryAlias !== alias
  ) {
    return entryConcealmentResponse(request);
  }

  const nextPath = sanitizeNextPath(url.searchParams.get('next'));

  let ticket;
  let acceptUrl;
  try {
    ticket = await createEntryHandoffToken(alias, targetAlias, env.ROUTE_SESSION_SECRET, {
      now: options.now,
      binding: nextPath
    });
    const baseDomain = normalizeBaseDomain(env.ROUTE_BASE_DOMAIN);
    if (!baseDomain) throw new TypeError('Entry handoff requires ROUTE_BASE_DOMAIN');
    const targetHostnameAlias = getProjectHostnameAlias(targetAlias, targetProject);
    const targetHostname = targetHostnameAlias
      ? `${targetHostnameAlias}.${baseDomain}`
      : baseDomain;
    acceptUrl = new URL(ENTRY_ACCEPT_PATH, `https://${targetHostname}`);
  } catch (error) {
    console.error('Worker entry handoff configuration is invalid:', error.name);
    return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
  }

  acceptUrl.searchParams.set('ticket', ticket);
  acceptUrl.searchParams.set('next', nextPath);
  return new Response(null, {
    status: 303,
    headers: {
      'Cache-Control': 'private, no-store',
      Location: acceptUrl.toString(),
      'Referrer-Policy': 'no-referrer'
    }
  });
}

async function acceptEntryHandoff(request, url, alias, project, env, options) {
  if (!alias || !project || project.entryAccess.mode !== 'required') {
    return entryConcealmentResponse(request);
  }

  const ticket = url.searchParams.get('ticket');
  const nextPath = sanitizeNextPath(url.searchParams.get('next'));
  let valid;
  try {
    valid = await verifyEntryHandoffToken(
      ticket,
      project.entryAccess.entryAlias,
      alias,
      env.ROUTE_SESSION_SECRET,
      { now: options.now, binding: nextPath }
    );
  } catch (error) {
    console.error('Worker entry handoff configuration is invalid:', error.name);
    return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
  }

  if (!valid) {
    return entryConcealmentResponse(request);
  }

  let redeemed;
  try {
    const redeemTicket = options.entryTicketRedeemer ?? redeemEntryHandoffTicket;
    redeemed = await redeemTicket(ticket, env);
  } catch (error) {
    console.error('Worker entry ticket redeemer is unavailable:', error.name);
    return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
  }

  if (!redeemed) {
    return entryConcealmentResponse(request);
  }

  try {
    const token = await createEntrySessionToken(
      project.entryAccess.entryAlias,
      alias,
      env.ROUTE_SESSION_SECRET,
      { now: options.now, ttlSeconds: project.entryAccess.ttlSeconds }
    );
    return new Response(null, {
      status: 303,
      headers: {
        'Cache-Control': 'private, no-store',
        Location: nextPath,
        'Referrer-Policy': 'no-referrer',
        'Set-Cookie': buildEntrySessionCookie(token, project.entryAccess.ttlSeconds)
      }
    });
  } catch (error) {
    console.error('Worker entry session configuration is invalid:', error.name);
    return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
  }
}

async function authenticateRequest(request, url, alias, project, env, options) {
  const nextPath = sanitizeNextPath(url.searchParams.get('next'));

  if (!isTrustedAuthenticationOrigin(request, url)) {
    return rejectAuthentication(nextPath);
  }

  if (Number(request.headers.get('content-length') || 0) > 4096) {
    return rejectAuthentication(nextPath);
  }

  const rawRateLimitKey = `${request.headers.get('cf-connecting-ip') || 'unknown'}\0${alias || 'unresolved'}`;
  const failureStore = options.loginFailureStore ?? loginFailureStore;
  const localLimit = readLoginFailureLimit(failureStore, rawRateLimitKey, options.now);

  if (localLimit.blocked) {
    return rateLimitedAuthenticationResponse(nextPath, localLimit.retryAfter);
  }

  if (!await allowsExternalLoginAttempt(env, rawRateLimitKey)) {
    return rateLimitedAuthenticationResponse(
      nextPath,
      Math.ceil(LOGIN_FAILURE_WINDOW_MS / 1000)
    );
  }

  let form;

  try {
    form = await request.formData();
  } catch {
    recordLoginFailure(failureStore, rawRateLimitKey, options.now);
    return rejectAuthentication(nextPath);
  }

  const password = form.get('password');
  const requestedNextPath = sanitizeNextPath(form.get('next') || nextPath);
  const edgeAccessRequired = Boolean(alias && project?.edgeAccess.mode === 'required');
  let passwordMatches = false;

  try {
    passwordMatches = await verifyWorkerPassword(
      password,
      edgeAccessRequired ? project.edgeAccess.passwordHash : DUMMY_PASSWORD_HASH,
      edgeAccessRequired
        ? env.ROUTE_SESSION_SECRET
        : env.ROUTE_SESSION_SECRET || DUMMY_SESSION_SECRET
    );
  } catch (error) {
    if (edgeAccessRequired) {
      console.error('Worker session configuration is invalid:', error.name);
      return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
    }
  }

  if (!edgeAccessRequired || !passwordMatches) {
    recordLoginFailure(failureStore, rawRateLimitKey, options.now);
    return rejectAuthentication(requestedNextPath);
  }

  let token;
  let sessionTtl;

  try {
    sessionTtl = parseWorkerSessionTtl(env.ROUTE_SESSION_TTL_SECONDS);
    token = await createWorkerSessionToken(alias, env.ROUTE_SESSION_SECRET, {
      now: options.now,
      ttlSeconds: sessionTtl
    });
  } catch (error) {
    console.error('Worker session configuration is invalid:', error.name);
    return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
  }

  failureStore.delete(rawRateLimitKey);
  return new Response(null, {
    status: 303,
    headers: {
      'Cache-Control': 'private, no-store',
      Location: requestedNextPath,
      'Set-Cookie': buildSessionCookie(token, sessionTtl)
    }
  });
}

async function verifyGatewaySession(request, alias, env, now) {
  try {
    return await verifyWorkerSessionToken(
      readCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME),
      alias,
      env.ROUTE_SESSION_SECRET,
      { now }
    );
  } catch (error) {
    console.error('Worker session configuration is invalid:', error.name);
    return null;
  }
}

async function verifyEntrySession(request, alias, project, env, now) {
  try {
    return await verifyEntrySessionToken(
      readCookie(request.headers.get('cookie'), ENTRY_SESSION_COOKIE_NAME),
      project.entryAccess.entryAlias,
      alias,
      env.ROUTE_SESSION_SECRET,
      { now }
    );
  } catch (error) {
    console.error('Worker entry session configuration is invalid:', error.name);
    return null;
  }
}

async function redeemEntryHandoffTicket(ticket, env) {
  const redeemer = env.ENTRY_TICKET_REDEEMER;
  if (
    !redeemer ||
    typeof redeemer.idFromName !== 'function' ||
    typeof redeemer.get !== 'function'
  ) {
    throw new TypeError('ENTRY_TICKET_REDEEMER Durable Object binding is required');
  }

  const [, expiresText] = String(ticket || '').split('.');
  const expiresAt = Number(expiresText) * 1000;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new TypeError('Entry handoff ticket expiration is invalid');
  }

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(ticket))
  );
  const ticketKey = [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  const objectId = redeemer.idFromName(ticketKey);
  const response = await redeemer.get(objectId).fetch('https://entry-ticket-redeemer/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresAt })
  });

  if (response.status === 204) return true;
  if (response.status === 409) return false;
  throw new TypeError(`Entry ticket redeemer returned ${response.status}`);
}

async function proxyRequest(request, requestUrl, project, env, fetchImpl) {
  let upstreamUrl;

  try {
    upstreamUrl = buildUpstreamUrl(
      project.target,
      requestUrl.pathname,
      requestUrl.searchParams.toString()
    );
  } catch {
    return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
  }

  let originSecret = '';

  if (project.originProtection.mode === 'required') {
    originSecret = env[project.originProtection.secretBinding];

    if (typeof originSecret !== 'string' || originSecret.length < 16) {
      console.error('Worker origin protection secret is unavailable');
      return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
    }
  }

  let upstreamHeaders;

  try {
    upstreamHeaders = buildUpstreamHeaders(request.headers, {
      sessionCookieNames: [SESSION_COOKIE_NAME, ENTRY_SESSION_COOKIE_NAME],
      originHeaderName: project.originProtection.headerName,
      originSecret,
      clientHost: requestUrl.host,
      clientIp: request.headers.get('cf-connecting-ip') || '',
      clientOrigin: requestUrl.origin,
      upstreamOrigin: upstreamUrl.origin,
      requestOriginPolicy: project.requestOriginPolicy
    });
  } catch (error) {
    if (error instanceof RequestOriginPolicyError) {
      return gatewayError('EDGE_ORIGIN_NOT_ALLOWED', '请求来源不受信任', 403);
    }

    console.error('Worker request origin policy is invalid:', error.name);
    return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
  }
  const fetchOptions = {
    method: request.method,
    headers: upstreamHeaders,
    redirect: 'manual'
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    fetchOptions.body = request.body;
  }

  let upstreamResponse;

  try {
    upstreamResponse = await fetchImpl(upstreamUrl, fetchOptions);
  } catch (error) {
    console.error('Worker upstream request failed:', error.name);

    if (isDocumentNavigation(request)) {
      return unavailableResponse(502);
    }

    return gatewayError('EDGE_UPSTREAM_UNAVAILABLE', '上游服务暂时不可用', 502);
  }

  const headers = copyUpstreamResponseHeaders(upstreamResponse.headers);
  const location = rewriteLocation(
    upstreamResponse.headers.get('location'),
    upstreamUrl,
    requestUrl.origin
  );

  if (location) {
    headers.set('Location', location);
  }

  const setCookies = getSetCookieValues(upstreamResponse.headers);

  for (const setCookie of setCookies) {
    headers.append(
      'Set-Cookie',
      rewriteSetCookieDomain(setCookie, requestUrl.hostname, project.cookieDomainPolicy)
    );
  }

  applyCachePolicy(headers, request, upstreamResponse, project, upstreamHeaders, setCookies);

  const cannotHaveBody = request.method === 'HEAD' || [101, 204, 205, 304].includes(upstreamResponse.status);

  return new Response(cannotHaveBody ? null : upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers
  });
}

function redirectToUpstream(requestUrl, project) {
  let upstreamUrl;

  try {
    upstreamUrl = buildUpstreamUrl(
      project.target,
      requestUrl.pathname,
      requestUrl.searchParams.toString()
    );
  } catch {
    return gatewayError('EDGE_CONFIGURATION_ERROR', '网关配置暂时不可用', 503);
  }

  return new Response(null, {
    status: 307,
    headers: {
      'Cache-Control': 'no-store',
      Location: upstreamUrl.toString()
    }
  });
}

function applyCachePolicy(headers, request, upstreamResponse, project, upstreamHeaders, setCookies) {
  const contentType = parseContentType(upstreamResponse.headers.get('content-type'));
  const hasApplicationCookie = upstreamHeaders.has('cookie');
  const cacheableAsset = project.cachePolicy === 'assets-only' &&
    ['GET', 'HEAD'].includes(request.method) &&
    upstreamResponse.status === 200 &&
    !request.headers.has('authorization') &&
    !hasApplicationCookie &&
    setCookies.length === 0 &&
    !isApiPath(new URL(request.url).pathname) &&
    !STREAMING_CONTENT_TYPES.has(contentType) &&
    isStaticAsset(new URL(request.url).pathname, contentType);

  if (!cacheableAsset) {
    headers.set('Cache-Control', 'no-store');
    return;
  }

  if (!headers.has('cache-control')) {
    headers.set('Cache-Control', `public, max-age=${STATIC_CACHE_MAX_AGE}`);
  }
}

function isStaticAsset(pathname, contentType) {
  const filename = pathname.split('/').pop() || '';
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';

  if (!STATIC_ASSET_EXTENSIONS.has(extension)) {
    return false;
  }

  return contentType.startsWith('image/') ||
    contentType.startsWith('font/') ||
    contentType.startsWith('audio/') ||
    contentType.startsWith('video/') ||
    contentType === 'application/javascript' ||
    contentType === 'application/pdf' ||
    contentType === 'application/wasm' ||
    contentType === 'image/svg+xml' ||
    contentType === 'text/css' ||
    contentType === 'text/javascript';
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function parseContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function resolveWorkerAlias(hostname, env, projects) {
  const host = hostname.toLowerCase();
  const baseDomain = normalizeBaseDomain(env.ROUTE_BASE_DOMAIN);

  if (baseDomain) {
    if (host === baseDomain) {
      const semanticAlias = resolveUnifiedEntryAlias(projects);
      const project = semanticAlias ? projects.get(semanticAlias) : null;
      return project && !getProjectHostnameAlias(semanticAlias, project)
        ? semanticAlias
        : null;
    }

    if (host.endsWith(`.${baseDomain}`)) {
      const hostnameAlias = host.slice(0, -(baseDomain.length + 1));
      if (!isValidRouteAlias(hostnameAlias)) return null;
      for (const [semanticAlias, project] of projects) {
        if (getProjectHostnameAlias(semanticAlias, project) === hostnameAlias) {
          return semanticAlias;
        }
      }
      return null;
    }

    return null;
  }

  if (projects.size !== 1) {
    throw new TypeError('ROUTE_BASE_DOMAIN is required for multiple applications');
  }

  return projects.keys().next().value;
}

function normalizeBaseDomain(rawValue) {
  const value = String(rawValue || '').trim().toLowerCase();

  if (!value) {
    return '';
  }

  if (value.includes('://') || value.includes('/') || value.includes('*') || value.includes(':')) {
    throw new TypeError('ROUTE_BASE_DOMAIN must be a hostname');
  }

  const parsed = new URL(`https://${value}`);

  if (parsed.hostname !== value || !value.includes('.')) {
    throw new TypeError('ROUTE_BASE_DOMAIN must be a hostname');
  }

  return value;
}

function resolveEntryTargetAlias(rawTarget, env, projects) {
  const value = String(rawTarget || '').trim().toLowerCase();
  if (!value) return null;
  if (isValidRouteAlias(value) && projects.has(value)) return value;

  let baseDomain;
  try {
    baseDomain = normalizeBaseDomain(env.ROUTE_BASE_DOMAIN);
  } catch {
    return null;
  }

  if (!baseDomain || !value.endsWith(`.${baseDomain}`)) return null;
  const hostnameAlias = value.slice(0, -(baseDomain.length + 1));
  if (!isValidRouteAlias(hostnameAlias)) return null;
  for (const [semanticAlias, project] of projects) {
    if (getProjectHostnameAlias(semanticAlias, project) === hostnameAlias) {
      return semanticAlias;
    }
  }
  return null;
}

function loginResponse(url, options = {}) {
  const showError = options.showError || url.searchParams.get('error') === 'unavailable';
  const nextPath = sanitizeNextPath(options.nextPath || url.searchParams.get('next'));
  const loginAction = `${LOGIN_PATH}?${new URLSearchParams({ next: nextPath })}`;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>访问验证</title><style>${PAGE_STYLES}</style></head>
<body><main class="shell"><section class="card" aria-labelledby="page-title"><div class="lock" aria-hidden="true"></div>
<h1 id="page-title">访问验证</h1><p class="subtitle">请输入密码后继续</p>
<div class="message" role="alert"${showError ? '' : ' hidden'}><span aria-hidden="true">!</span><strong>无法验证，请稍后重试</strong></div>
<form action="${escapeHtml(loginAction)}" method="post"><input name="next" type="hidden" value="${escapeHtml(nextPath)}">
<label class="sr-only" for="password">访问密码</label><input id="password" name="password" type="password" maxlength="256" autocomplete="current-password" placeholder="访问密码" autofocus required>
<button type="submit">继续</button></form></section></main></body></html>`;
  return htmlResponse(html, options.status || 200, options.headers);
}

function unavailableResponse(status) {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>暂时不可用</title><style>${PAGE_STYLES}</style></head>
<body><main class="shell"><section class="card unavailable" role="alert"><div class="unavailable-mark" aria-hidden="true">!</div>
<h1>暂时不可用</h1><p class="subtitle">请稍后重试</p></section></main></body></html>`;
  return htmlResponse(html, status);
}

function isTrustedAuthenticationOrigin(request, url) {
  const origin = request.headers.get('origin');

  if (origin) {
    return origin === url.origin;
  }

  const referer = request.headers.get('referer');

  if (!referer) {
    return false;
  }

  try {
    return new URL(referer).origin === url.origin;
  } catch {
    return false;
  }
}

function isTrustedEntryLaunch(request, url) {
  const fetchSite = String(request.headers.get('sec-fetch-site') || '').toLowerCase();
  const fetchMode = String(request.headers.get('sec-fetch-mode') || '').toLowerCase();
  const fetchDestination = String(request.headers.get('sec-fetch-dest') || '').toLowerCase();
  const fetchUser = String(request.headers.get('sec-fetch-user') || '').toLowerCase();

  if (fetchSite || fetchMode || fetchDestination || fetchUser) {
    return (
      fetchSite === 'same-origin' &&
      fetchMode === 'navigate' &&
      fetchDestination === 'document' &&
      fetchUser === '?1'
    );
  }

  return isTrustedAuthenticationOrigin(request, url);
}

function isDocumentNavigation(request) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return false;
  }

  const accept = String(request.headers.get('accept') || '').toLowerCase();
  const mode = String(request.headers.get('sec-fetch-mode') || '').toLowerCase();
  const destination = String(request.headers.get('sec-fetch-dest') || '').toLowerCase();
  return accept.includes('text/html') && mode === 'navigate' && destination === 'document';
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

function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function buildEntrySessionCookie(token, ttlSeconds) {
  return `${ENTRY_SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}

function readLoginFailureLimit(store, key, now) {
  const entry = store.get(key);

  if (!entry || entry.expiresAt <= now) {
    store.delete(key);
    return { blocked: false, retryAfter: 0 };
  }

  return {
    blocked: entry.count >= LOGIN_FAILURE_LIMIT,
    retryAfter: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000))
  };
}

function recordLoginFailure(store, key, now) {
  const current = store.get(key);
  const entry = current && current.expiresAt > now
    ? current
    : { count: 0, expiresAt: now + LOGIN_FAILURE_WINDOW_MS };
  entry.count += 1;
  store.set(key, entry);

  if (store.size > 10000) {
    for (const [storedKey, storedEntry] of store) {
      if (storedEntry.expiresAt <= now) {
        store.delete(storedKey);
      }

      if (store.size <= 9000) {
        break;
      }
    }
  }
}

async function allowsExternalLoginAttempt(env, rawKey) {
  const limiter = env.EDGE_LOGIN_RATE_LIMITER;

  if (!limiter || typeof limiter.limit !== 'function') {
    return true;
  }

  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey));
    const key = bytesToBase64Url(new Uint8Array(digest));
    const result = await limiter.limit({ key });
    return result?.success !== false;
  } catch (error) {
    console.error('Worker login rate limiter is unavailable:', error.name);
    return true;
  }
}

function bytesToBase64Url(bytes) {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function rejectAuthentication(nextPath) {
  console.warn('Worker authentication rejected');
  const query = new URLSearchParams({
    error: 'unavailable',
    next: sanitizeNextPath(nextPath)
  });
  return redirectResponse(`${LOGIN_PATH}?${query}`);
}

function rateLimitedAuthenticationResponse(nextPath, retryAfter) {
  const url = new URL(`https://gateway.invalid${LOGIN_PATH}`);
  return loginResponse(url, {
    showError: true,
    nextPath,
    status: 429,
    headers: { 'Retry-After': String(retryAfter) }
  });
}

function methodNotAllowed(allowedMethods) {
  return new Response(JSON.stringify({
    error: {
      code: 'EDGE_METHOD_NOT_ALLOWED',
      message: '请求方法不受支持'
    }
  }), {
    status: 405,
    headers: {
      Allow: allowedMethods.join(', '),
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function gatewayError(code, message, status) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function entryConcealmentResponse(request) {
  const headers = {
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive'
  };

  if (!isDocumentNavigation(request)) {
    return new Response(null, { status: 404, headers });
  }

  headers['Content-Type'] = 'text/html; charset=utf-8';
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow,noarchive">
<title>页面无法打开</title><style>${CONCEALMENT_PAGE_STYLES}</style></head>
<body><main class="shell"><section class="error" aria-labelledby="page-title">
<div class="visual" aria-hidden="true"><svg viewBox="0 0 200 180" role="presentation">
<rect class="halo" x="10" y="10" width="180" height="160" rx="42"></rect>
<rect class="window" x="34" y="30" width="132" height="120" rx="13"></rect><path class="window-bar" d="M34 62h132"></path>
<circle class="error-ring" cx="100" cy="104" r="25"></circle><path class="error-mark" d="m90 94 20 20m0-20-20 20"></path>
</svg></div>
<div class="copy"><p class="status"><span></span>404 · PAGE NOT FOUND</p><h1 id="page-title">页面无法打开</h1>
<p class="description">请检查地址拼写是否正确，或稍后重新加载页面。</p></div>
</section></main></body></html>`;
  return new Response(
    html,
    { status: 404, headers }
  );
}

function redirectResponse(location) {
  return new Response(null, {
    status: 303,
    headers: {
      'Cache-Control': 'private, no-store',
      Location: location
    }
  });
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      ...extraHeaders
    }
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const PAGE_STYLES = `:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fa}*{box-sizing:border-box}body{min-width:320px;min-height:100vh;margin:0;background:#f5f7fa}.shell{display:grid;min-height:100vh;place-items:center;padding:20px}.card{width:min(100%,380px);padding:36px;border:1px solid #e4e9f0;border-radius:18px;background:#fff;box-shadow:0 18px 50px rgb(15 23 42/8%)}.lock{position:relative;width:42px;height:36px;margin:0 auto 24px;border-radius:10px;background:#172033}.lock:before{position:absolute;top:-16px;left:9px;width:20px;height:22px;border:3px solid #172033;border-bottom:0;border-radius:12px 12px 0 0;content:""}.lock:after{position:absolute;top:14px;left:19px;width:4px;height:9px;border-radius:4px;background:#fff;content:""}h1{margin:0;font-size:26px;line-height:1.25;text-align:center}.subtitle{margin:8px 0 26px;color:#7b8494;font-size:14px;text-align:center}.message{display:flex;gap:11px;align-items:center;margin:0 0 16px;padding:12px;border:1px solid #fecaca;border-radius:10px;color:#991b1b;background:#fff5f5}.message[hidden]{display:none}.message span{display:grid;flex:0 0 28px;width:28px;height:28px;place-items:center;border-radius:50%;color:#fff;background:#dc2626;font-weight:800}.message strong{font-size:14px}form{display:grid;gap:12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}input,button{width:100%;height:48px;border-radius:10px;font:inherit}input{padding:0 14px;border:1px solid #cfd6e1;outline:none;color:#172033;background:#fff}input:focus{border-color:#172033;box-shadow:0 0 0 3px rgb(23 32 51/10%)}button{border:0;color:#fff;background:#172033;font-weight:700;cursor:pointer}.unavailable{text-align:center}.unavailable-mark{display:grid;width:46px;height:46px;margin:0 auto 24px;place-items:center;border-radius:50%;color:#fff;background:#dc2626;font-size:24px;font-weight:800}.unavailable .subtitle{margin-bottom:0}@media(max-width:480px){.card{padding:32px 22px}}`;

const CONCEALMENT_PAGE_STYLES = `:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#20242c;background:#f1f3f6}*{box-sizing:border-box}body{min-width:320px;min-height:100vh;margin:0;background:radial-gradient(circle at 22% 18%,rgb(255 255 255/95%) 0,transparent 38%),radial-gradient(circle at 82% 84%,rgb(218 223 232/75%) 0,transparent 34%),#f1f3f6}.shell{display:grid;min-height:100vh;place-items:center;padding:48px 32px}.error{display:grid;grid-template-columns:minmax(280px,340px) minmax(300px,1fr);gap:72px;align-items:center;width:min(100%,900px);min-height:440px;padding:56px 64px;border:1px solid rgb(165 173 185/28%);border-radius:32px;background:rgb(255 255 255/78%);box-shadow:0 30px 80px rgb(35 42 53/10%);backdrop-filter:blur(18px)}.visual{display:grid;min-height:300px;place-items:center;border:1px solid rgb(159 169 182/20%);border-radius:25px;background:linear-gradient(145deg,rgb(245 247 250/95%),rgb(232 236 242/88%));box-shadow:inset 0 1px 0 rgb(255 255 255/85%)}.visual svg{display:block;width:min(78%,230px);height:auto;overflow:visible}.halo{fill:#fff;stroke:#d8dde5;stroke-width:1.5}.window{fill:#f8f9fb;stroke:#78818d;stroke-width:3}.window-bar{fill:none;stroke:#b8bfc9;stroke-width:3}.error-ring{fill:#737c88}.error-mark{fill:none;stroke:#fff;stroke-linecap:round;stroke-width:4}.copy{padding:10px 0}.status{display:flex;gap:10px;align-items:center;margin:0 0 24px;color:#858d99;font-size:11px;font-weight:760;letter-spacing:.14em}.status span{width:24px;height:2px;border-radius:2px;background:#858d99}.error h1{margin:0;color:#20242c;font-size:clamp(36px,4vw,46px);font-weight:720;letter-spacing:-.045em;line-height:1.16}.description{max-width:360px;margin:20px 0 0;color:#6e7682;font-size:16px;line-height:1.85}@media(prefers-color-scheme:dark){:root{color:#eef1f5;background:#111318}body{background:radial-gradient(circle at 22% 18%,rgb(45 50 59/65%) 0,transparent 38%),radial-gradient(circle at 82% 84%,rgb(37 41 49/75%) 0,transparent 34%),#111318}.error{border-color:rgb(137 147 160/18%);background:rgb(28 31 37/82%);box-shadow:0 32px 90px rgb(0 0 0/34%)}.visual{border-color:rgb(145 154 166/16%);background:linear-gradient(145deg,rgb(42 46 54/92%),rgb(31 34 40/92%));box-shadow:inset 0 1px 0 rgb(255 255 255/5%)}.halo{fill:#292d34;stroke:#444a55}.window{fill:#22262c;stroke:#9aa3af}.window-bar{stroke:#5d6570}.error-ring{fill:#a3abb6}.error-mark{stroke:#20242a}.status{color:#8f97a3}.status span{background:#8f97a3}.error h1{color:#f1f3f6}.description{color:#a0a7b1}}@media(max-width:860px){.shell{padding:24px 18px}.error{grid-template-columns:1fr;gap:34px;width:min(100%,520px);min-height:0;padding:26px 26px 36px;border-radius:26px}.visual{min-height:230px}.visual svg{width:min(68%,190px)}.copy{text-align:center}.status{justify-content:center;margin-bottom:18px}.error h1{font-size:34px}.description{margin:15px auto 0;font-size:15px;line-height:1.75}}`;
