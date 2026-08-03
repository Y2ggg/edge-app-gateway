// lib/proxy-utils.js
var REQUEST_HEADER_ALLOWLIST = [
  "accept",
  "accept-language",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "range",
  "user-agent"
];
function buildUpstreamUrl(target, requestPath, rawQuery = "") {
  const targetUrl = new URL(target);
  const safePath = normalizeRequestPath(requestPath);
  const basePath = targetUrl.pathname === "/" ? "" : targetUrl.pathname.replace(/\/$/, "");
  const alreadyIncludesBasePath = basePath && (safePath === basePath || safePath.startsWith(`${basePath}/`));
  targetUrl.pathname = alreadyIncludesBasePath ? safePath : `${basePath}${safePath}`;
  if (basePath && targetUrl.pathname !== basePath && !targetUrl.pathname.startsWith(`${basePath}/`)) {
    throw new TypeError("Request path escapes the configured target base path");
  }
  targetUrl.search = rawQuery ? `?${rawQuery}` : "";
  return targetUrl;
}
function buildUpstreamHeaders(headers) {
  const upstreamHeaders = new Headers();
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = readHeader(headers, name);
    if (value) {
      upstreamHeaders.set(name, value);
    }
  }
  upstreamHeaders.set("accept-encoding", "identity");
  return upstreamHeaders;
}
function rewriteLocation(location, upstreamUrl, proxyOrigin) {
  if (!location) {
    return "";
  }
  let redirectUrl;
  try {
    redirectUrl = new URL(location, upstreamUrl);
  } catch {
    return "";
  }
  if (redirectUrl.origin === upstreamUrl.origin) {
    return `${proxyOrigin}${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`;
  }
  return redirectUrl.toString();
}
function sanitizeNextPath(rawPath) {
  const nextPath = typeof rawPath === "string" ? rawPath : "/";
  if (!nextPath.startsWith("/") || nextPath.startsWith("//") || /[\r\n]/.test(nextPath)) {
    return "/";
  }
  if (nextPath.startsWith("/__route/")) {
    return "/";
  }
  return nextPath;
}
function normalizeRequestPath(rawPath) {
  const path = typeof rawPath === "string" ? rawPath : "/";
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) {
    return "/";
  }
  return path;
}
function readHeader(headers, name) {
  if (typeof headers?.get === "function") {
    return headers.get(name) || "";
  }
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || "");
}

// lib/route-config.js
var ROUTE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
var MAX_ROUTE_COUNT = 200;
var RouteConfigurationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "RouteConfigurationError";
  }
};
function isValidRouteAlias(alias) {
  return typeof alias === "string" && ROUTE_ALIAS_PATTERN.test(alias);
}
function parseRouteProjects(rawConfig) {
  if (typeof rawConfig !== "string" || rawConfig.length === 0) {
    throw new RouteConfigurationError("ROUTE_PROJECTS_JSON is missing");
  }
  let parsed;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    throw new RouteConfigurationError("ROUTE_PROJECTS_JSON must be valid JSON");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new RouteConfigurationError("ROUTE_PROJECTS_JSON must be an object");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > MAX_ROUTE_COUNT) {
    throw new RouteConfigurationError(`Route count must be between 1 and ${MAX_ROUTE_COUNT}`);
  }
  const projects = /* @__PURE__ */ new Map();
  for (const [alias, project] of entries) {
    if (!isValidRouteAlias(alias)) {
      throw new RouteConfigurationError(`Invalid route alias: ${alias}`);
    }
    if (project === null || Array.isArray(project) || typeof project !== "object") {
      throw new RouteConfigurationError(`Project ${alias} must be an object`);
    }
    const { target, passwordHash, rewriteOrigins = false } = project;
    if (typeof target !== "string" || typeof passwordHash !== "string" || !passwordHash) {
      throw new RouteConfigurationError(`Project ${alias} requires target and passwordHash strings`);
    }
    if (typeof rewriteOrigins !== "boolean") {
      throw new RouteConfigurationError(`Project ${alias} rewriteOrigins must be a boolean`);
    }
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      throw new RouteConfigurationError(`Target for ${alias} must be a valid URL`);
    }
    if (targetUrl.protocol !== "https:" || targetUrl.username || targetUrl.password || targetUrl.search || targetUrl.hash) {
      throw new RouteConfigurationError(
        `Target for ${alias} must be a credential-free HTTPS URL without a query or fragment`
      );
    }
    if (!targetUrl.hostname.endsWith(".vercel.app")) {
      throw new RouteConfigurationError(`Target for ${alias} must be hosted under vercel.app`);
    }
    projects.set(alias, Object.freeze({
      target: targetUrl.toString(),
      passwordHash,
      rewriteOrigins
    }));
  }
  return projects;
}

// src/worker-crypto.js
var encoder = new TextEncoder();
var PASSWORD_KEY_BYTES = 32;
var MINIMUM_SECRET_LENGTH = 32;
var PASSWORD_HASH_PREFIX = "hmac-sha256";
var PASSWORD_MESSAGE_PREFIX = "route-password-v1\0";
async function verifyWorkerPassword(password, encodedHash, secret) {
  if (typeof password !== "string" || password.length === 0 || password.length > 256) {
    return false;
  }
  validateSecret(secret);
  const [prefix, saltText, hashText, ...extra] = String(encodedHash || "").split("$");
  if (prefix !== PASSWORD_HASH_PREFIX || extra.length > 0) {
    throw new TypeError("Project passwordHash must use the hmac-sha256 format");
  }
  const salt = base64UrlToBytes(saltText);
  const expectedHash = base64UrlToBytes(hashText);
  if (salt.length < 16 || expectedHash.length !== PASSWORD_KEY_BYTES) {
    throw new TypeError("Project passwordHash has invalid key material");
  }
  const actualHash = await passwordDigest(password, salt, secret);
  return constantTimeEqual(actualHash, expectedHash);
}
async function createWorkerSessionToken(alias, secret, options = {}) {
  validateSecret(secret);
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1e3);
  const ttlSeconds = options.ttlSeconds ?? 28800;
  const payload = bytesToBase64Url(
    encoder.encode(JSON.stringify({ alias, exp: nowSeconds + ttlSeconds }))
  );
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}
async function verifyWorkerSessionToken(token, alias, secret, options = {}) {
  validateSecret(secret);
  const [payload, providedSignature, ...extra] = String(token || "").split(".");
  if (!payload || !providedSignature || extra.length > 0) {
    return false;
  }
  const expectedSignature = await sign(payload, secret);
  if (!constantTimeEqual(
    encoder.encode(providedSignature),
    encoder.encode(expectedSignature)
  )) {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch {
    return false;
  }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1e3);
  return parsed?.alias === alias && Number.isInteger(parsed.exp) && parsed.exp > nowSeconds;
}
function parseWorkerSessionTtl(rawValue) {
  if (rawValue === void 0 || rawValue === "") {
    return 28800;
  }
  const ttlSeconds = Number(rawValue);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 604800) {
    throw new TypeError("ROUTE_SESSION_TTL_SECONDS must be between 300 and 604800");
  }
  return ttlSeconds;
}
async function passwordDigest(password, salt, secret) {
  const message = `${PASSWORD_MESSAGE_PREFIX}${bytesToBase64Url(salt)}\0${password}`;
  return signBytes(message, secret);
}
async function sign(payload, secret) {
  return bytesToBase64Url(await signBytes(payload, secret));
}
async function signBytes(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return new Uint8Array(signature);
}
function validateSecret(secret) {
  if (typeof secret !== "string" || secret.length < MINIMUM_SECRET_LENGTH) {
    throw new TypeError(`ROUTE_SESSION_SECRET must contain at least ${MINIMUM_SECRET_LENGTH} characters`);
  }
}
function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function base64UrlToBytes(value) {
  const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// src/worker.js
var SESSION_COOKIE_NAME = "route_session";
var LOGIN_PATH = "/__route/login";
var LOGIN_SCRIPT_PATH = "/__route/login.js";
var AUTH_PATH = "/__route/auth";
var SUCCESS_PATH = "/__route/success";
var SUCCESS_SCRIPT_PATH = "/__route/success.js";
var UNAVAILABLE_PATH = "/__route/unavailable";
var HEALTH_PATH = "/__route/health";
var WORKER_BUILD_ID = "2026-08-03-route-v2";
var DUMMY_PASSWORD_HASH = "hmac-sha256$ZHVtbXktcm91dGUtc2FsdA$7VCcQ_9KLIdA9rWiYngmq7WGpRLkQkrmKULgLmqv_5M";
var REWRITABLE_CONTENT_TYPES = /* @__PURE__ */ new Set([
  "application/json",
  "application/manifest+json",
  "application/xml",
  "image/svg+xml",
  "text/css",
  "text/html",
  "text/xml"
]);
var RESPONSE_HEADER_ALLOWLIST = [
  "accept-ranges",
  "content-disposition",
  "content-language",
  "content-range",
  "content-security-policy",
  "content-type",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "etag",
  "last-modified",
  "permissions-policy",
  "service-worker-allowed",
  "x-frame-options"
];
var worker_default = {
  fetch(request, env) {
    return handleWorkerRequest(request, env);
  }
};
async function handleWorkerRequest(request, env, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const url = new URL(request.url);
  if (url.pathname === HEALTH_PATH) {
    return jsonResponse({
      ok: true,
      build: WORKER_BUILD_ID,
      edge: request.cf?.colo || "local"
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
    console.error("Worker configuration is invalid:", error.name);
    return acceptsHtml(request) ? unavailableResponse() : textResponse("Not Found", 404);
  }
  if (url.pathname === LOGIN_PATH && request.method === "GET") {
    return loginResponse(url);
  }
  if (url.pathname === LOGIN_SCRIPT_PATH && request.method === "GET") {
    return scriptResponse(LOGIN_SCRIPT);
  }
  if (url.pathname === SUCCESS_PATH && request.method === "GET") {
    return successResponse();
  }
  if (url.pathname === SUCCESS_SCRIPT_PATH && request.method === "GET") {
    return scriptResponse(SUCCESS_SCRIPT);
  }
  if (url.pathname === UNAVAILABLE_PATH && request.method === "GET") {
    return unavailableResponse();
  }
  const project = alias ? projects.get(alias) : null;
  if (url.pathname === AUTH_PATH) {
    return authenticateRequest(request, url, alias, project, env, sessionTtl, now);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" }
    });
  }
  let authenticated = false;
  try {
    authenticated = alias && await verifyWorkerSessionToken(
      readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME),
      alias,
      env.ROUTE_SESSION_SECRET,
      { now }
    );
  } catch (error) {
    console.error("Worker session configuration is invalid:", error.name);
    return unavailableForRequest(request);
  }
  if (!authenticated) {
    if (acceptsHtml(request)) {
      const loginUrl = new URL(LOGIN_PATH, url.origin);
      loginUrl.searchParams.set("next", sanitizeNextPath(`${url.pathname}${url.search}`));
      return redirectResponse(`${loginUrl.pathname}${loginUrl.search}`);
    }
    return textResponse("Authentication required", 401);
  }
  if (!project) {
    return unavailableForRequest(request);
  }
  return proxyRequest(request, url, project, fetchImpl);
}
async function authenticateRequest(request, url, alias, project, env, sessionTtl, now) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" }
    });
  }
  if (!isTrustedAuthenticationOrigin(request, url)) {
    return rejectAuthentication("/", "origin-mismatch");
  }
  if (Number(request.headers.get("content-length") || 0) > 4096) {
    return rejectAuthentication("/", "body-too-large");
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return rejectAuthentication("/", "invalid-form");
  }
  const password = form.get("password");
  const nextPath = sanitizeNextPath(form.get("next"));
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
    return rejectAuthentication(nextPath, "route-not-resolved");
  }
  if (!project) {
    return rejectAuthentication(nextPath, "project-not-found");
  }
  if (!passwordMatches) {
    return rejectAuthentication(nextPath, "password-mismatch");
  }
  let token;
  try {
    token = await createWorkerSessionToken(alias, env.ROUTE_SESSION_SECRET, {
      now,
      ttlSeconds: sessionTtl
    });
  } catch (error) {
    console.error("Worker session configuration is invalid:", error.name);
    return redirectToLogin(nextPath);
  }
  const successUrl = new URL(SUCCESS_PATH, url.origin);
  successUrl.searchParams.set("next", nextPath);
  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: `${successUrl.pathname}${successUrl.search}`,
    "Set-Cookie": buildSessionCookie(token, sessionTtl)
  });
  return new Response(null, { status: 303, headers });
}
function isTrustedAuthenticationOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin === url.origin) {
    return true;
  }
  const fetchSite = String(request.headers.get("sec-fetch-site") || "").toLowerCase();
  return !origin && fetchSite === "same-origin";
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
      redirect: "manual"
    });
  } catch (error) {
    console.error("Worker upstream request failed:", error.name);
    return unavailableForRequest(request);
  }
  if (upstreamResponse.status >= 400 && acceptsHtml(request)) {
    return redirectResponse(UNAVAILABLE_PATH);
  }
  const headers = copyResponseHeaders(upstreamResponse.headers);
  const location = rewriteLocation(
    upstreamResponse.headers.get("location"),
    upstreamUrl,
    requestUrl.origin
  );
  if (location) {
    headers.set("Location", location);
  }
  const shouldRewrite = project.rewriteOrigins && shouldRewriteText(
    upstreamResponse,
    request.headers.has("range")
  );
  if (shouldRewrite) {
    headers.delete("etag");
    const contentSecurityPolicy = headers.get("content-security-policy");
    if (contentSecurityPolicy) {
      headers.set(
        "content-security-policy",
        rewriteText(contentSecurityPolicy, upstreamUrl.origin, requestUrl.origin)
      );
    }
  }
  if (request.method === "HEAD" || !upstreamResponse.body) {
    return new Response(null, {
      status: upstreamResponse.status,
      headers
    });
  }
  const body = shouldRewrite ? upstreamResponse.body.pipeThrough(createOriginRewriteStream(
    upstreamUrl.origin,
    requestUrl.origin
  )) : upstreamResponse.body;
  return new Response(body, {
    status: upstreamResponse.status,
    headers
  });
}
function resolveWorkerAlias(hostname, env, projects) {
  const host = hostname.toLowerCase();
  const baseDomain = String(env.ROUTE_BASE_DOMAIN || "").trim().toLowerCase();
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
  const showError = url.searchParams.get("error") === "unavailable";
  const nextPath = sanitizeNextPath(url.searchParams.get("next"));
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>\u8BBF\u95EE\u9A8C\u8BC1</title><style>${PAGE_STYLES}</style>
<script src="${LOGIN_SCRIPT_PATH}" type="module"><\/script></head><body><main class="shell"><section class="card" aria-labelledby="page-title">
<div class="lock" aria-hidden="true"></div><h1 id="page-title">\u8BBF\u95EE\u9A8C\u8BC1</h1><p class="subtitle">\u8BF7\u8F93\u5165\u5BC6\u7801\u540E\u7EE7\u7EED</p>
<div class="message" id="message" role="alert"${showError ? "" : " hidden"}><span class="message-icon" aria-hidden="true">!</span><strong>\u65E0\u6CD5\u8BBF\u95EE</strong></div>
<form action="${AUTH_PATH}" method="post" id="route-form"><input name="next" type="hidden" value="${escapeHtml(nextPath)}">
<label class="sr-only" for="password">\u8BBF\u95EE\u5BC6\u7801</label><input id="password" name="password" type="password" maxlength="256" autocomplete="current-password" placeholder="\u8BBF\u95EE\u5BC6\u7801" autofocus required>
<button type="submit" id="submit-button">\u7EE7\u7EED</button></form></section></main></body></html>`;
  return htmlResponse(html);
}
function successResponse() {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>\u9A8C\u8BC1\u901A\u8FC7</title><style>${PAGE_STYLES}</style>
<script src="${SUCCESS_SCRIPT_PATH}" type="module"><\/script></head><body><main class="shell"><section class="card success" aria-live="polite">
<div class="loader" aria-hidden="true"></div><h1>\u9A8C\u8BC1\u901A\u8FC7</h1><p class="subtitle">\u6B63\u5728\u8FDB\u5165</p>
</section></main></body></html>`;
  return htmlResponse(html);
}
function unavailableResponse() {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>\u65E0\u6CD5\u8BBF\u95EE</title><style>${PAGE_STYLES}</style></head>
<body><main class="shell"><section class="card unavailable" role="alert"><div class="unavailable-mark" aria-hidden="true">!</div><h1>\u65E0\u6CD5\u8BBF\u95EE</h1></section></main></body></html>`;
  return htmlResponse(html);
}
function createOriginRewriteStream(upstreamOrigin, proxyOrigin) {
  const replacements = buildReplacements(upstreamOrigin, proxyOrigin);
  const maximumTargetLength = Math.max(...replacements.map(([target]) => target.length));
  const decoder = new TextDecoder();
  const encoder2 = new TextEncoder();
  let carry = "";
  return new TransformStream({
    transform(chunk, controller) {
      const text = carry + decoder.decode(chunk, { stream: true });
      const rewritten = applyReplacements(text, replacements);
      const retainedLength = Math.min(maximumTargetLength - 1, rewritten.length);
      const emitLength = rewritten.length - retainedLength;
      carry = rewritten.slice(emitLength);
      controller.enqueue(encoder2.encode(rewritten.slice(0, emitLength)));
    },
    flush(controller) {
      controller.enqueue(encoder2.encode(
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
    [upstreamOrigin.replaceAll("/", "\\/"), proxyOrigin.replaceAll("/", "\\/")]
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
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  return response.status === 200 && !hasRangeRequest && REWRITABLE_CONTENT_TYPES.has(contentType);
}
function copyResponseHeaders(upstreamHeaders) {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
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
  for (const part of String(rawCookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return "";
}
function buildSessionCookie(token, ttlSeconds) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}
function redirectToLogin(nextPath) {
  const query = new URLSearchParams({
    error: "unavailable",
    next: sanitizeNextPath(nextPath)
  });
  return redirectResponse(`${LOGIN_PATH}?${query}`);
}
function rejectAuthentication(nextPath, reason) {
  console.warn(`Worker authentication rejected: ${reason}`);
  return redirectToLogin(nextPath);
}
function unavailableForRequest(request) {
  return acceptsHtml(request) ? redirectResponse(UNAVAILABLE_PATH) : textResponse("Not Found", 404);
}
function redirectResponse(location) {
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: location
    }
  });
}
function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    }
  });
}
function scriptResponse(script) {
  return new Response(script, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
function acceptsHtml(request) {
  const accept = request.headers.get("accept") || "";
  return !accept || accept.includes("text/html");
}
function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
var LOGIN_SCRIPT = `const form=document.querySelector('#route-form');const message=document.querySelector('#message');const password=document.querySelector('#password');const button=document.querySelector('#submit-button');form.addEventListener('submit',()=>{message.hidden=true;password.readOnly=true;button.disabled=true;button.textContent='\u9A8C\u8BC1\u4E2D';});`;
var SUCCESS_SCRIPT = `const parameters=new URLSearchParams(window.location.search);const requested=parameters.get('next')||'/';const next=requested.startsWith('/')&&!requested.startsWith('//')&&!requested.startsWith('/__route/')?requested:'/';window.setTimeout(()=>window.location.replace(next),900);`;
var PAGE_STYLES = `:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fa;font-synthesis:none}*{box-sizing:border-box}body{min-width:320px;min-height:100vh;margin:0;background:#f5f7fa}.shell{display:grid;min-height:100vh;place-items:center;padding:20px}.card{width:min(100%,380px);padding:36px;border:1px solid #e4e9f0;border-radius:18px;background:#fff;box-shadow:0 18px 50px rgb(15 23 42/8%)}.lock{position:relative;width:42px;height:36px;margin:0 auto 24px;border-radius:10px;background:#172033}.lock:before{position:absolute;top:-16px;left:9px;width:20px;height:22px;border:3px solid #172033;border-bottom:0;border-radius:12px 12px 0 0;content:""}.lock:after{position:absolute;top:14px;left:19px;width:4px;height:9px;border-radius:4px;background:#fff;content:""}h1{margin:0;font-size:26px;line-height:1.25;text-align:center;letter-spacing:-.02em}.subtitle{margin:8px 0 26px;color:#7b8494;font-size:14px;text-align:center}.message{display:flex;gap:11px;align-items:center;margin:0 0 16px;padding:12px;border:1px solid #fecaca;border-radius:10px;color:#991b1b;background:#fff5f5}.message[hidden]{display:none}.message-icon{display:grid;flex:0 0 28px;width:28px;height:28px;place-items:center;border-radius:50%;color:#fff;background:#dc2626;font-weight:800}.message strong{font-size:14px}form{display:grid;gap:12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}input,button{width:100%;height:48px;border-radius:10px;font:inherit}input{padding:0 14px;border:1px solid #cfd6e1;outline:none;color:#172033;background:#fff}input:focus{border-color:#172033;box-shadow:0 0 0 3px rgb(23 32 51/10%)}button{border:0;color:#fff;background:#172033;font-weight:700;cursor:pointer}button:hover:not(:disabled){background:#293855}button:disabled{cursor:wait;opacity:.78}.success,.unavailable{text-align:center}.loader{width:46px;height:46px;margin:0 auto 24px;border:4px solid #e4e9f0;border-top-color:#172033;border-radius:50%;animation:spin 750ms linear infinite}.success .subtitle{margin-bottom:0}.unavailable-mark{display:grid;width:46px;height:46px;margin:0 auto 24px;place-items:center;border-radius:50%;color:#fff;background:#dc2626;font-size:24px;font-weight:800}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:480px){.card{padding:32px 22px}}`;
export {
  worker_default as default,
  handleWorkerRequest
};
