// lib/proxy-utils.js
var HOP_BY_HOP_HEADERS = /* @__PURE__ */ new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
var FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto"
];
var RequestOriginPolicyError = class extends Error {
  constructor() {
    super("Request Origin is not allowed by the configured policy");
    this.name = "RequestOriginPolicyError";
  }
};
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
function buildUpstreamHeaders(headers, options = {}) {
  const upstreamHeaders = new Headers(headers || {});
  const connectionHeaders = String(upstreamHeaders.get("connection") || "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  for (const name of [...HOP_BY_HOP_HEADERS, ...connectionHeaders]) {
    upstreamHeaders.delete(name);
  }
  upstreamHeaders.delete("host");
  for (const name of FORWARDED_HEADERS) {
    upstreamHeaders.delete(name);
  }
  for (const [name] of upstreamHeaders) {
    if (name.toLowerCase().startsWith("x-edge-app-gateway-origin")) {
      upstreamHeaders.delete(name);
    }
  }
  upstreamHeaders.delete("x-vercel-protection-bypass");
  upstreamHeaders.delete("x-vercel-set-bypass-cookie");
  if (options.originHeaderName) {
    upstreamHeaders.delete(options.originHeaderName);
  }
  const cookie = removeCookie(
    upstreamHeaders.get("cookie"),
    options.sessionCookieName || "route_session"
  );
  if (cookie) {
    upstreamHeaders.set("cookie", cookie);
  } else {
    upstreamHeaders.delete("cookie");
  }
  if (options.clientHost) {
    upstreamHeaders.set("x-forwarded-host", options.clientHost);
  }
  upstreamHeaders.set("x-forwarded-proto", "https");
  if (options.clientIp) {
    upstreamHeaders.set("x-forwarded-for", options.clientIp);
  }
  if (options.originHeaderName && options.originSecret) {
    upstreamHeaders.set(options.originHeaderName, options.originSecret);
  }
  applyRequestOriginPolicy(upstreamHeaders, options);
  return upstreamHeaders;
}
function applyRequestOriginPolicy(headers, options = {}) {
  if (options.requestOriginPolicy !== "rewrite-to-upstream") {
    return;
  }
  const clientOrigin = parseExpectedOrigin(options.clientOrigin);
  const upstreamOrigin = parseExpectedOrigin(options.upstreamOrigin);
  const requestOrigin = headers.get("origin");
  if (requestOrigin) {
    if (!isSerializedOrigin(requestOrigin, clientOrigin)) {
      throw new RequestOriginPolicyError();
    }
    headers.set("origin", upstreamOrigin);
  }
  const referer = headers.get("referer");
  if (!referer) {
    return;
  }
  let refererUrl;
  try {
    refererUrl = new URL(referer);
  } catch {
    return;
  }
  if (["http:", "https:"].includes(refererUrl.protocol) && refererUrl.origin === clientOrigin) {
    headers.set(
      "referer",
      `${upstreamOrigin}${refererUrl.pathname}${refererUrl.search}${refererUrl.hash}`
    );
  }
}
function copyUpstreamResponseHeaders(upstreamHeaders) {
  const headers = new Headers();
  const connectionHeaders = String(upstreamHeaders.get("connection") || "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  const blocked = /* @__PURE__ */ new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaders, "set-cookie"]);
  upstreamHeaders.forEach((value, name) => {
    if (!blocked.has(name.toLowerCase())) {
      headers.append(name, value);
    }
  });
  return headers;
}
function getSetCookieValues(headers) {
  if (typeof headers?.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  if (typeof headers?.getAll === "function") {
    try {
      return headers.getAll("Set-Cookie");
    } catch {
    }
  }
  const combined = headers?.get?.("set-cookie");
  return combined ? splitCombinedSetCookie(combined) : [];
}
function rewriteSetCookieDomain(setCookie, hostname, policy = "strip") {
  const domainPattern = /;\s*domain\s*=\s*[^;]*/i;
  if (!domainPattern.test(setCookie)) {
    return setCookie;
  }
  if (policy === "rewrite") {
    return setCookie.replace(domainPattern, `; Domain=${hostname}`);
  }
  return setCookie.replace(domainPattern, "");
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
  if (nextPath.startsWith("/_edge-gateway/")) {
    return "/";
  }
  return nextPath;
}
function removeCookie(rawCookie, name) {
  return String(rawCookie || "").split(";").map((part) => part.trim()).filter((part) => part && part.slice(0, part.indexOf("=")).trim() !== name).join("; ");
}
function normalizeRequestPath(rawPath) {
  const path = typeof rawPath === "string" ? rawPath : "/";
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) {
    return "/";
  }
  return path;
}
function parseExpectedOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    throw new TypeError("Origin policy requires valid client and upstream origins");
  }
}
function isSerializedOrigin(value, expectedOrigin) {
  if (value === "null" || value.includes(" ") || value.includes(",")) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return value === parsed.origin && parsed.origin === expectedOrigin;
  } catch {
    return false;
  }
}
function splitCombinedSetCookie(value) {
  const cookies = [];
  let start = 0;
  let inExpires = false;
  for (let index = 0; index < value.length; index += 1) {
    const remainder = value.slice(index).toLowerCase();
    if (remainder.startsWith("expires=")) {
      inExpires = true;
    } else if (inExpires && value[index] === ";") {
      inExpires = false;
    } else if (value[index] === "," && !inExpires) {
      cookies.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  cookies.push(value.slice(start).trim());
  return cookies.filter(Boolean);
}

// lib/route-config.js
var ROUTE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
var SECRET_BINDING_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
var HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
var MAX_ROUTE_COUNT = 200;
var SUPPORTED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
var SUPPORTED_METHOD_SET = new Set(SUPPORTED_METHODS);
var FORBIDDEN_ORIGIN_HEADERS = /* @__PURE__ */ new Set([
  "authorization",
  "cf-connecting-ip",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-vercel-protection-bypass"
]);
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
  for (const [alias, rawProject] of entries) {
    projects.set(alias, parseProject(alias, rawProject));
  }
  return projects;
}
function parseProject(alias, project) {
  if (!isValidRouteAlias(alias)) {
    throw new RouteConfigurationError(`Invalid route alias: ${alias}`);
  }
  if (project === null || Array.isArray(project) || typeof project !== "object") {
    throw new RouteConfigurationError(`Application ${alias} must be an object`);
  }
  const target = parseTarget(alias, project.target);
  const deliveryMode = requireEnum(alias, "deliveryMode", project.deliveryMode, ["proxy", "redirect"]);
  const proxyProfile = requireEnum(alias, "proxyProfile", project.proxyProfile, ["static", "fullstack"]);
  const requestOriginPolicy = project.requestOriginPolicy === void 0 ? "preserve" : requireEnum(
    alias,
    "requestOriginPolicy",
    project.requestOriginPolicy,
    ["preserve", "rewrite-to-upstream"]
  );
  const edgeAccess = parseEdgeAccess(alias, project.edgeAccess);
  const originProtection = parseOriginProtection(alias, project.originProtection);
  const allowedMethods = parseAllowedMethods(alias, project.allowedMethods, proxyProfile);
  const cachePolicy = project.cachePolicy === void 0 ? "no-store" : requireEnum(alias, "cachePolicy", project.cachePolicy, ["assets-only", "no-store"]);
  const cookieDomainPolicy = project.cookieDomainPolicy === void 0 ? "strip" : requireEnum(alias, "cookieDomainPolicy", project.cookieDomainPolicy, ["strip", "rewrite"]);
  if (deliveryMode === "redirect" && originProtection.mode === "required") {
    throw new RouteConfigurationError(
      `Application ${alias} cannot require origin protection in redirect mode`
    );
  }
  if (deliveryMode === "redirect" && requestOriginPolicy !== "preserve") {
    throw new RouteConfigurationError(
      `Application ${alias} cannot rewrite request origins in redirect mode`
    );
  }
  if (deliveryMode === "redirect" && allowedMethods.some((method) => !["GET", "HEAD"].includes(method))) {
    throw new RouteConfigurationError(
      `Application ${alias} redirect mode only supports GET and HEAD`
    );
  }
  return Object.freeze({
    target,
    deliveryMode,
    proxyProfile,
    requestOriginPolicy,
    edgeAccess,
    originProtection,
    allowedMethods,
    cachePolicy,
    cookieDomainPolicy
  });
}
function parseTarget(alias, target) {
  if (typeof target !== "string" || !target) {
    throw new RouteConfigurationError(`Application ${alias} requires a target string`);
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
  return targetUrl.toString();
}
function parseEdgeAccess(alias, edgeAccess) {
  if (edgeAccess === null || Array.isArray(edgeAccess) || typeof edgeAccess !== "object") {
    throw new RouteConfigurationError(`Application ${alias} requires edgeAccess configuration`);
  }
  const mode = requireEnum(alias, "edgeAccess.mode", edgeAccess.mode, ["disabled", "required"]);
  if (mode === "required") {
    if (typeof edgeAccess.passwordHash !== "string" || !edgeAccess.passwordHash) {
      throw new RouteConfigurationError(
        `Application ${alias} requires edgeAccess.passwordHash when Edge Access is required`
      );
    }
    return Object.freeze({ mode, passwordHash: edgeAccess.passwordHash });
  }
  return Object.freeze({ mode });
}
function parseOriginProtection(alias, originProtection) {
  if (originProtection === null || Array.isArray(originProtection) || typeof originProtection !== "object") {
    throw new RouteConfigurationError(`Application ${alias} requires originProtection configuration`);
  }
  const mode = requireEnum(
    alias,
    "originProtection.mode",
    originProtection.mode,
    ["disabled", "required"]
  );
  if (mode === "disabled") {
    return Object.freeze({ mode });
  }
  const headerName = String(originProtection.headerName || "").toLowerCase();
  const secretBinding = originProtection.secretBinding;
  if (!headerName.startsWith("x-") || !HEADER_NAME_PATTERN.test(headerName) || FORBIDDEN_ORIGIN_HEADERS.has(headerName)) {
    throw new RouteConfigurationError(
      `Application ${alias} originProtection.headerName is invalid or unsafe`
    );
  }
  if (typeof secretBinding !== "string" || !SECRET_BINDING_PATTERN.test(secretBinding)) {
    throw new RouteConfigurationError(
      `Application ${alias} originProtection.secretBinding must be a valid binding name`
    );
  }
  return Object.freeze({ mode, headerName, secretBinding });
}
function parseAllowedMethods(alias, rawMethods, proxyProfile) {
  if (!Array.isArray(rawMethods) || rawMethods.length === 0) {
    throw new RouteConfigurationError(`Application ${alias} requires a non-empty allowedMethods array`);
  }
  const methods = [];
  for (const rawMethod of rawMethods) {
    const method = typeof rawMethod === "string" ? rawMethod.toUpperCase() : "";
    if (!SUPPORTED_METHOD_SET.has(method)) {
      throw new RouteConfigurationError(`Application ${alias} contains an unsupported HTTP method`);
    }
    if (methods.includes(method)) {
      throw new RouteConfigurationError(`Application ${alias} contains a duplicate HTTP method`);
    }
    methods.push(method);
  }
  if (proxyProfile === "static" && methods.some((method) => !["GET", "HEAD", "OPTIONS"].includes(method))) {
    throw new RouteConfigurationError(
      `Application ${alias} static profile cannot enable write methods`
    );
  }
  return Object.freeze(SUPPORTED_METHODS.filter((method) => methods.includes(method)));
}
function requireEnum(alias, name, value, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new RouteConfigurationError(
      `Application ${alias} ${name} must be one of: ${allowedValues.join(", ")}`
    );
  }
  return value;
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
    throw new TypeError("Application passwordHash must use the hmac-sha256 format");
  }
  const salt = base64UrlToBytes(saltText);
  const expectedHash = base64UrlToBytes(hashText);
  if (salt.length < 16 || expectedHash.length !== PASSWORD_KEY_BYTES) {
    throw new TypeError("Application passwordHash has invalid key material");
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
var GATEWAY_PREFIX = "/_edge-gateway/";
var LOGIN_PATH = `${GATEWAY_PREFIX}login`;
var LOGOUT_PATH = `${GATEWAY_PREFIX}logout`;
var SESSION_PATH = `${GATEWAY_PREFIX}session`;
var HEALTH_PATH = `${GATEWAY_PREFIX}health`;
var WORKER_BUILD_ID = "2026-08-21-gateway-v5";
var DUMMY_PASSWORD_HASH = "hmac-sha256$ZHVtbXktcm91dGUtc2FsdA$7VCcQ_9KLIdA9rWiYngmq7WGpRLkQkrmKULgLmqv_5M";
var DUMMY_SESSION_SECRET = "dummy-session-secret-for-unresolved-routes";
var LOGIN_FAILURE_LIMIT = 5;
var LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1e3;
var STATIC_CACHE_MAX_AGE = 3600;
var loginFailureStore = /* @__PURE__ */ new Map();
var STATIC_ASSET_EXTENSIONS = /* @__PURE__ */ new Set([
  "avif",
  "css",
  "eot",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "js",
  "map",
  "mjs",
  "mp3",
  "mp4",
  "ogg",
  "otf",
  "pdf",
  "png",
  "svg",
  "ttf",
  "wasm",
  "webm",
  "webp",
  "woff",
  "woff2"
]);
var STREAMING_CONTENT_TYPES = /* @__PURE__ */ new Set([
  "application/json-seq",
  "application/ndjson",
  "application/x-ndjson",
  "text/event-stream"
]);
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
  try {
    projects = parseRouteProjects(env.ROUTE_PROJECTS_JSON);
    alias = resolveWorkerAlias(url.hostname, env, projects);
  } catch (error) {
    console.error("Worker configuration is invalid:", error.name);
    return gatewayError("EDGE_CONFIGURATION_ERROR", "\u7F51\u5173\u914D\u7F6E\u6682\u65F6\u4E0D\u53EF\u7528", 503);
  }
  const project = alias ? projects.get(alias) : null;
  if (url.pathname.startsWith(GATEWAY_PREFIX)) {
    return handleGatewayRequest(request, url, alias, project, env, {
      ...options,
      now
    });
  }
  if (!project) {
    return gatewayError("EDGE_ROUTE_NOT_FOUND", "\u8BF7\u6C42\u7684\u5165\u53E3\u4E0D\u53EF\u7528", 404);
  }
  if (!project.allowedMethods.includes(request.method)) {
    return methodNotAllowed(project.allowedMethods);
  }
  if (project.edgeAccess.mode === "required") {
    const authenticated = await verifyGatewaySession(request, alias, env, now);
    if (authenticated === null) {
      return gatewayError("EDGE_CONFIGURATION_ERROR", "\u7F51\u5173\u914D\u7F6E\u6682\u65F6\u4E0D\u53EF\u7528", 503);
    }
    if (!authenticated) {
      if (isDocumentNavigation(request)) {
        const loginUrl = new URL(LOGIN_PATH, url.origin);
        loginUrl.searchParams.set("next", sanitizeNextPath(`${url.pathname}${url.search}`));
        return redirectResponse(`${loginUrl.pathname}${loginUrl.search}`);
      }
      return gatewayError("EDGE_AUTHENTICATION_REQUIRED", "\u9700\u8981\u901A\u8FC7\u8FB9\u7F18\u8BBF\u95EE\u9A8C\u8BC1", 401);
    }
  }
  if (project.deliveryMode === "redirect") {
    return redirectToUpstream(url, project);
  }
  return proxyRequest(request, url, project, env, fetchImpl);
}
async function handleGatewayRequest(request, url, alias, project, env, options) {
  if (url.pathname === LOGIN_PATH) {
    if (request.method === "GET") {
      return loginResponse(url);
    }
    if (request.method === "POST") {
      return authenticateRequest(request, url, alias, project, env, options);
    }
    return methodNotAllowed(["GET", "POST"]);
  }
  if (url.pathname === LOGOUT_PATH) {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!isTrustedAuthenticationOrigin(request, url)) {
      return gatewayError("EDGE_REQUEST_REJECTED", "\u8BF7\u6C42\u672A\u901A\u8FC7\u5B89\u5168\u6821\u9A8C", 403);
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "private, no-store",
        "Set-Cookie": clearSessionCookie()
      }
    });
  }
  if (url.pathname === SESSION_PATH) {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    let authenticated = false;
    if (alias && project?.edgeAccess.mode === "required") {
      const result = await verifyGatewaySession(request, alias, env, options.now);
      if (result === null) {
        return gatewayError("EDGE_CONFIGURATION_ERROR", "\u7F51\u5173\u914D\u7F6E\u6682\u65F6\u4E0D\u53EF\u7528", 503);
      }
      authenticated = result;
    }
    return jsonResponse({ authenticated });
  }
  return gatewayError("EDGE_GATEWAY_ENDPOINT_NOT_FOUND", "\u7F51\u5173\u63A5\u53E3\u4E0D\u5B58\u5728", 404);
}
async function authenticateRequest(request, url, alias, project, env, options) {
  const nextPath = sanitizeNextPath(url.searchParams.get("next"));
  if (!isTrustedAuthenticationOrigin(request, url)) {
    return rejectAuthentication(nextPath);
  }
  if (Number(request.headers.get("content-length") || 0) > 4096) {
    return rejectAuthentication(nextPath);
  }
  const rawRateLimitKey = `${request.headers.get("cf-connecting-ip") || "unknown"}\0${alias || "unresolved"}`;
  const failureStore = options.loginFailureStore ?? loginFailureStore;
  const localLimit = readLoginFailureLimit(failureStore, rawRateLimitKey, options.now);
  if (localLimit.blocked) {
    return rateLimitedAuthenticationResponse(nextPath, localLimit.retryAfter);
  }
  if (!await allowsExternalLoginAttempt(env, rawRateLimitKey)) {
    return rateLimitedAuthenticationResponse(
      nextPath,
      Math.ceil(LOGIN_FAILURE_WINDOW_MS / 1e3)
    );
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    recordLoginFailure(failureStore, rawRateLimitKey, options.now);
    return rejectAuthentication(nextPath);
  }
  const password = form.get("password");
  const requestedNextPath = sanitizeNextPath(form.get("next") || nextPath);
  const edgeAccessRequired = Boolean(alias && project?.edgeAccess.mode === "required");
  let passwordMatches = false;
  try {
    passwordMatches = await verifyWorkerPassword(
      password,
      edgeAccessRequired ? project.edgeAccess.passwordHash : DUMMY_PASSWORD_HASH,
      edgeAccessRequired ? env.ROUTE_SESSION_SECRET : env.ROUTE_SESSION_SECRET || DUMMY_SESSION_SECRET
    );
  } catch (error) {
    if (edgeAccessRequired) {
      console.error("Worker session configuration is invalid:", error.name);
      return gatewayError("EDGE_CONFIGURATION_ERROR", "\u7F51\u5173\u914D\u7F6E\u6682\u65F6\u4E0D\u53EF\u7528", 503);
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
    console.error("Worker session configuration is invalid:", error.name);
    return gatewayError("EDGE_CONFIGURATION_ERROR", "\u7F51\u5173\u914D\u7F6E\u6682\u65F6\u4E0D\u53EF\u7528", 503);
  }
  failureStore.delete(rawRateLimitKey);
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "private, no-store",
      Location: requestedNextPath,
      "Set-Cookie": buildSessionCookie(token, sessionTtl)
    }
  });
}
async function verifyGatewaySession(request, alias, env, now) {
  try {
    return await verifyWorkerSessionToken(
      readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME),
      alias,
      env.ROUTE_SESSION_SECRET,
      { now }
    );
  } catch (error) {
    console.error("Worker session configuration is invalid:", error.name);
    return null;
  }
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
    return gatewayError("EDGE_CONFIGURATION_ERROR", "\u7F51\u5173\u914D\u7F6E\u6682\u65F6\u4E0D\u53EF\u7528", 503);
  }
  let originSecret = "";
  if (project.originProtection.mode === "required") {
    originSecret = env[project.originProtection.secretBinding];
    if (typeof originSecret !== "string" || originSecret.length < 16) {
      console.error("Worker origin protection secret is unavailable");
      return gatewayError("EDGE_CONFIGURATION_ERROR", "\u7F51\u5173\u914D\u7F6E\u6682\u65F6\u4E0D\u53EF\u7528", 503);
    }
  }
  let upstreamHeaders;
  try {
    upstreamHeaders = buildUpstreamHeaders(request.headers, {
      sessionCookieName: SESSION_COOKIE_NAME,
      originHeaderName: project.originProtection.headerName,
      originSecret,
      clientHost: requestUrl.host,
      clientIp: request.headers.get("cf-connecting-ip") || "",
      clientOrigin: requestUrl.origin,
      upstreamOrigin: upstreamUrl.origin,
      requestOriginPolicy: project.requestOriginPolicy
    });
  } catch (error) {
    if (error instanceof RequestOriginPolicyError) {
      return gatewayError("EDGE_ORIGIN_NOT_ALLOWED", "\u8BF7\u6C42\u6765\u6E90\u4E0D\u53D7\u4FE1\u4EFB", 403);
    }
    console.error("Worker request origin policy is invalid:", error.name);
    return gatewayError("EDGE_CONFIGURATION_ERROR", "\u7F51\u5173\u914D\u7F6E\u6682\u65F6\u4E0D\u53EF\u7528", 503);
  }
  const fetchOptions = {
    method: request.method,
    headers: upstreamHeaders,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    fetchOptions.body = request.body;
  }
  let upstreamResponse;
  try {
    upstreamResponse = await fetchImpl(upstreamUrl, fetchOptions);
  } catch (error) {
    console.error("Worker upstream request failed:", error.name);
    if (isDocumentNavigation(request)) {
      return unavailableResponse(502);
    }
    return gatewayError("EDGE_UPSTREAM_UNAVAILABLE", "\u4E0A\u6E38\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528", 502);
  }
  const headers = copyUpstreamResponseHeaders(upstreamResponse.headers);
  const location = rewriteLocation(
    upstreamResponse.headers.get("location"),
    upstreamUrl,
    requestUrl.origin
  );
  if (location) {
    headers.set("Location", location);
  }
  const setCookies = getSetCookieValues(upstreamResponse.headers);
  for (const setCookie of setCookies) {
    headers.append(
      "Set-Cookie",
      rewriteSetCookieDomain(setCookie, requestUrl.hostname, project.cookieDomainPolicy)
    );
  }
  applyCachePolicy(headers, request, upstreamResponse, project, upstreamHeaders, setCookies);
  const cannotHaveBody = request.method === "HEAD" || [101, 204, 205, 304].includes(upstreamResponse.status);
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
    return gatewayError("EDGE_CONFIGURATION_ERROR", "\u7F51\u5173\u914D\u7F6E\u6682\u65F6\u4E0D\u53EF\u7528", 503);
  }
  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": "no-store",
      Location: upstreamUrl.toString()
    }
  });
}
function applyCachePolicy(headers, request, upstreamResponse, project, upstreamHeaders, setCookies) {
  const contentType = parseContentType(upstreamResponse.headers.get("content-type"));
  const hasApplicationCookie = upstreamHeaders.has("cookie");
  const cacheableAsset = project.cachePolicy === "assets-only" && ["GET", "HEAD"].includes(request.method) && upstreamResponse.status === 200 && !request.headers.has("authorization") && !hasApplicationCookie && setCookies.length === 0 && !isApiPath(new URL(request.url).pathname) && !STREAMING_CONTENT_TYPES.has(contentType) && isStaticAsset(new URL(request.url).pathname, contentType);
  if (!cacheableAsset) {
    headers.set("Cache-Control", "no-store");
    return;
  }
  if (!headers.has("cache-control")) {
    headers.set("Cache-Control", `public, max-age=${STATIC_CACHE_MAX_AGE}`);
  }
}
function isStaticAsset(pathname, contentType) {
  const filename = pathname.split("/").pop() || "";
  const extension = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  if (!STATIC_ASSET_EXTENSIONS.has(extension)) {
    return false;
  }
  return contentType.startsWith("image/") || contentType.startsWith("font/") || contentType.startsWith("audio/") || contentType.startsWith("video/") || contentType === "application/javascript" || contentType === "application/pdf" || contentType === "application/wasm" || contentType === "image/svg+xml" || contentType === "text/css" || contentType === "text/javascript";
}
function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}
function parseContentType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}
function resolveWorkerAlias(hostname, env, projects) {
  const host = hostname.toLowerCase();
  const baseDomain = normalizeBaseDomain(env.ROUTE_BASE_DOMAIN);
  if (baseDomain) {
    if (host.endsWith(`.${baseDomain}`)) {
      const alias = host.slice(0, -(baseDomain.length + 1));
      return isValidRouteAlias(alias) ? alias : null;
    }
    return null;
  }
  return projects.size === 1 ? projects.keys().next().value : null;
}
function normalizeBaseDomain(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) {
    return "";
  }
  if (value.includes("://") || value.includes("/") || value.includes("*") || value.includes(":")) {
    throw new TypeError("ROUTE_BASE_DOMAIN must be a hostname");
  }
  const parsed = new URL(`https://${value}`);
  if (parsed.hostname !== value || !value.includes(".")) {
    throw new TypeError("ROUTE_BASE_DOMAIN must be a hostname");
  }
  return value;
}
function loginResponse(url, options = {}) {
  const showError = options.showError || url.searchParams.get("error") === "unavailable";
  const nextPath = sanitizeNextPath(options.nextPath || url.searchParams.get("next"));
  const loginAction = `${LOGIN_PATH}?${new URLSearchParams({ next: nextPath })}`;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>\u8BBF\u95EE\u9A8C\u8BC1</title><style>${PAGE_STYLES}</style></head>
<body><main class="shell"><section class="card" aria-labelledby="page-title"><div class="lock" aria-hidden="true"></div>
<h1 id="page-title">\u8BBF\u95EE\u9A8C\u8BC1</h1><p class="subtitle">\u8BF7\u8F93\u5165\u5BC6\u7801\u540E\u7EE7\u7EED</p>
<div class="message" role="alert"${showError ? "" : " hidden"}><span aria-hidden="true">!</span><strong>\u65E0\u6CD5\u9A8C\u8BC1\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5</strong></div>
<form action="${escapeHtml(loginAction)}" method="post"><input name="next" type="hidden" value="${escapeHtml(nextPath)}">
<label class="sr-only" for="password">\u8BBF\u95EE\u5BC6\u7801</label><input id="password" name="password" type="password" maxlength="256" autocomplete="current-password" placeholder="\u8BBF\u95EE\u5BC6\u7801" autofocus required>
<button type="submit">\u7EE7\u7EED</button></form></section></main></body></html>`;
  return htmlResponse(html, options.status || 200, options.headers);
}
function unavailableResponse(status) {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>\u6682\u65F6\u4E0D\u53EF\u7528</title><style>${PAGE_STYLES}</style></head>
<body><main class="shell"><section class="card unavailable" role="alert"><div class="unavailable-mark" aria-hidden="true">!</div>
<h1>\u6682\u65F6\u4E0D\u53EF\u7528</h1><p class="subtitle">\u8BF7\u7A0D\u540E\u91CD\u8BD5</p></section></main></body></html>`;
  return htmlResponse(html, status);
}
function isTrustedAuthenticationOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === url.origin;
  }
  const referer = request.headers.get("referer");
  if (!referer) {
    return false;
  }
  try {
    return new URL(referer).origin === url.origin;
  } catch {
    return false;
  }
}
function isDocumentNavigation(request) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return false;
  }
  const accept = String(request.headers.get("accept") || "").toLowerCase();
  const mode = String(request.headers.get("sec-fetch-mode") || "").toLowerCase();
  const destination = String(request.headers.get("sec-fetch-dest") || "").toLowerCase();
  return accept.includes("text/html") && mode === "navigate" && destination === "document";
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
function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
function readLoginFailureLimit(store, key, now) {
  const entry = store.get(key);
  if (!entry || entry.expiresAt <= now) {
    store.delete(key);
    return { blocked: false, retryAfter: 0 };
  }
  return {
    blocked: entry.count >= LOGIN_FAILURE_LIMIT,
    retryAfter: Math.max(1, Math.ceil((entry.expiresAt - now) / 1e3))
  };
}
function recordLoginFailure(store, key, now) {
  const current = store.get(key);
  const entry = current && current.expiresAt > now ? current : { count: 0, expiresAt: now + LOGIN_FAILURE_WINDOW_MS };
  entry.count += 1;
  store.set(key, entry);
  if (store.size > 1e4) {
    for (const [storedKey, storedEntry] of store) {
      if (storedEntry.expiresAt <= now) {
        store.delete(storedKey);
      }
      if (store.size <= 9e3) {
        break;
      }
    }
  }
}
async function allowsExternalLoginAttempt(env, rawKey) {
  const limiter = env.EDGE_LOGIN_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") {
    return true;
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
    const key = bytesToBase64Url2(new Uint8Array(digest));
    const result = await limiter.limit({ key });
    return result?.success !== false;
  } catch (error) {
    console.error("Worker login rate limiter is unavailable:", error.name);
    return true;
  }
}
function bytesToBase64Url2(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function rejectAuthentication(nextPath) {
  console.warn("Worker authentication rejected");
  const query = new URLSearchParams({
    error: "unavailable",
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
    headers: { "Retry-After": String(retryAfter) }
  });
}
function methodNotAllowed(allowedMethods) {
  return new Response(JSON.stringify({
    error: {
      code: "EDGE_METHOD_NOT_ALLOWED",
      message: "\u8BF7\u6C42\u65B9\u6CD5\u4E0D\u53D7\u652F\u6301"
    }
  }), {
    status: 405,
    headers: {
      Allow: allowedMethods.join(", "),
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
function gatewayError(code, message, status) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
function redirectResponse(location) {
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "private, no-store",
      Location: location
    }
  });
}
function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...extraHeaders
    }
  });
}
function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
var PAGE_STYLES = `:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fa}*{box-sizing:border-box}body{min-width:320px;min-height:100vh;margin:0;background:#f5f7fa}.shell{display:grid;min-height:100vh;place-items:center;padding:20px}.card{width:min(100%,380px);padding:36px;border:1px solid #e4e9f0;border-radius:18px;background:#fff;box-shadow:0 18px 50px rgb(15 23 42/8%)}.lock{position:relative;width:42px;height:36px;margin:0 auto 24px;border-radius:10px;background:#172033}.lock:before{position:absolute;top:-16px;left:9px;width:20px;height:22px;border:3px solid #172033;border-bottom:0;border-radius:12px 12px 0 0;content:""}.lock:after{position:absolute;top:14px;left:19px;width:4px;height:9px;border-radius:4px;background:#fff;content:""}h1{margin:0;font-size:26px;line-height:1.25;text-align:center}.subtitle{margin:8px 0 26px;color:#7b8494;font-size:14px;text-align:center}.message{display:flex;gap:11px;align-items:center;margin:0 0 16px;padding:12px;border:1px solid #fecaca;border-radius:10px;color:#991b1b;background:#fff5f5}.message[hidden]{display:none}.message span{display:grid;flex:0 0 28px;width:28px;height:28px;place-items:center;border-radius:50%;color:#fff;background:#dc2626;font-weight:800}.message strong{font-size:14px}form{display:grid;gap:12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}input,button{width:100%;height:48px;border-radius:10px;font:inherit}input{padding:0 14px;border:1px solid #cfd6e1;outline:none;color:#172033;background:#fff}input:focus{border-color:#172033;box-shadow:0 0 0 3px rgb(23 32 51/10%)}button{border:0;color:#fff;background:#172033;font-weight:700;cursor:pointer}.unavailable{text-align:center}.unavailable-mark{display:grid;width:46px;height:46px;margin:0 auto 24px;place-items:center;border-radius:50%;color:#fff;background:#dc2626;font-size:24px;font-weight:800}.unavailable .subtitle{margin-bottom:0}@media(max-width:480px){.card{padding:32px 22px}}`;
export {
  worker_default as default,
  handleWorkerRequest
};
