const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const FORWARDED_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto'
];

export class RequestOriginPolicyError extends Error {
  constructor() {
    super('Request Origin is not allowed by the configured policy');
    this.name = 'RequestOriginPolicyError';
  }
}

export function buildUpstreamUrl(target, requestPath, rawQuery = '') {
  const targetUrl = new URL(target);
  const safePath = normalizeRequestPath(requestPath);
  const basePath = targetUrl.pathname === '/' ? '' : targetUrl.pathname.replace(/\/$/, '');
  const alreadyIncludesBasePath = basePath && (
    safePath === basePath || safePath.startsWith(`${basePath}/`)
  );
  targetUrl.pathname = alreadyIncludesBasePath ? safePath : `${basePath}${safePath}`;

  if (basePath && targetUrl.pathname !== basePath && !targetUrl.pathname.startsWith(`${basePath}/`)) {
    throw new TypeError('Request path escapes the configured target base path');
  }

  targetUrl.search = rawQuery ? `?${rawQuery}` : '';
  return targetUrl;
}

export function buildUpstreamHeaders(headers, options = {}) {
  const upstreamHeaders = new Headers(headers || {});
  const connectionHeaders = String(upstreamHeaders.get('connection') || '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);

  for (const name of [...HOP_BY_HOP_HEADERS, ...connectionHeaders]) {
    upstreamHeaders.delete(name);
  }

  upstreamHeaders.delete('host');

  for (const name of FORWARDED_HEADERS) {
    upstreamHeaders.delete(name);
  }

  for (const [name] of upstreamHeaders) {
    if (name.toLowerCase().startsWith('x-edge-app-gateway-origin')) {
      upstreamHeaders.delete(name);
    }
  }

  upstreamHeaders.delete('x-vercel-protection-bypass');
  upstreamHeaders.delete('x-vercel-set-bypass-cookie');

  if (options.originHeaderName) {
    upstreamHeaders.delete(options.originHeaderName);
  }

  const cookie = removeCookie(
    upstreamHeaders.get('cookie'),
    options.sessionCookieName || 'route_session'
  );

  if (cookie) {
    upstreamHeaders.set('cookie', cookie);
  } else {
    upstreamHeaders.delete('cookie');
  }

  if (options.clientHost) {
    upstreamHeaders.set('x-forwarded-host', options.clientHost);
  }

  upstreamHeaders.set('x-forwarded-proto', 'https');

  if (options.clientIp) {
    upstreamHeaders.set('x-forwarded-for', options.clientIp);
  }

  if (options.originHeaderName && options.originSecret) {
    upstreamHeaders.set(options.originHeaderName, options.originSecret);
  }

  applyRequestOriginPolicy(upstreamHeaders, options);

  return upstreamHeaders;
}

export function applyRequestOriginPolicy(headers, options = {}) {
  if (options.requestOriginPolicy !== 'rewrite-to-upstream') {
    return;
  }

  const clientOrigin = parseExpectedOrigin(options.clientOrigin);
  const upstreamOrigin = parseExpectedOrigin(options.upstreamOrigin);
  const requestOrigin = headers.get('origin');

  if (requestOrigin) {
    if (!isSerializedOrigin(requestOrigin, clientOrigin)) {
      throw new RequestOriginPolicyError();
    }

    headers.set('origin', upstreamOrigin);
  }

  const referer = headers.get('referer');

  if (!referer) {
    return;
  }

  let refererUrl;

  try {
    refererUrl = new URL(referer);
  } catch {
    return;
  }

  if (
    ['http:', 'https:'].includes(refererUrl.protocol) &&
    refererUrl.origin === clientOrigin
  ) {
    headers.set(
      'referer',
      `${upstreamOrigin}${refererUrl.pathname}${refererUrl.search}${refererUrl.hash}`
    );
  }
}

export function copyUpstreamResponseHeaders(upstreamHeaders) {
  const headers = new Headers();
  const connectionHeaders = String(upstreamHeaders.get('connection') || '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaders, 'set-cookie']);

  upstreamHeaders.forEach((value, name) => {
    if (!blocked.has(name.toLowerCase())) {
      headers.append(name, value);
    }
  });

  return headers;
}

export function getSetCookieValues(headers) {
  if (typeof headers?.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  if (typeof headers?.getAll === 'function') {
    try {
      return headers.getAll('Set-Cookie');
    } catch {
      // Fall through for standards-only Headers implementations.
    }
  }

  const combined = headers?.get?.('set-cookie');
  return combined ? splitCombinedSetCookie(combined) : [];
}

export function rewriteSetCookieDomain(setCookie, hostname, policy = 'strip') {
  const domainPattern = /;\s*domain\s*=\s*[^;]*/i;

  if (!domainPattern.test(setCookie)) {
    return setCookie;
  }

  if (policy === 'rewrite') {
    return setCookie.replace(domainPattern, `; Domain=${hostname}`);
  }

  return setCookie.replace(domainPattern, '');
}

export function rewriteLocation(location, upstreamUrl, proxyOrigin) {
  if (!location) {
    return '';
  }

  let redirectUrl;

  try {
    redirectUrl = new URL(location, upstreamUrl);
  } catch {
    return '';
  }

  if (redirectUrl.origin === upstreamUrl.origin) {
    return `${proxyOrigin}${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`;
  }

  return redirectUrl.toString();
}

export function sanitizeNextPath(rawPath) {
  const nextPath = typeof rawPath === 'string' ? rawPath : '/';

  if (!nextPath.startsWith('/') || nextPath.startsWith('//') || /[\r\n]/.test(nextPath)) {
    return '/';
  }

  if (nextPath.startsWith('/_edge-gateway/')) {
    return '/';
  }

  return nextPath;
}

export function removeCookie(rawCookie, name) {
  return String(rawCookie || '')
    .split(';')
    .map(part => part.trim())
    .filter(part => part && part.slice(0, part.indexOf('=')).trim() !== name)
    .join('; ');
}

function normalizeRequestPath(rawPath) {
  const path = typeof rawPath === 'string' ? rawPath : '/';

  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) {
    return '/';
  }

  return path;
}

function parseExpectedOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    throw new TypeError('Origin policy requires valid client and upstream origins');
  }
}

function isSerializedOrigin(value, expectedOrigin) {
  if (value === 'null' || value.includes(' ') || value.includes(',')) {
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

    if (remainder.startsWith('expires=')) {
      inExpires = true;
    } else if (inExpires && value[index] === ';') {
      inExpires = false;
    } else if (value[index] === ',' && !inExpires) {
      cookies.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  cookies.push(value.slice(start).trim());
  return cookies.filter(Boolean);
}
