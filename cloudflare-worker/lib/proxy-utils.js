const REQUEST_HEADER_ALLOWLIST = [
  'accept',
  'accept-language',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'range',
  'user-agent'
];

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

export function buildUpstreamHeaders(headers) {
  const upstreamHeaders = new Headers();

  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = readHeader(headers, name);

    if (value) {
      upstreamHeaders.set(name, value);
    }
  }

  upstreamHeaders.set('accept-encoding', 'identity');
  return upstreamHeaders;
}

export function copyUpstreamHeaders(upstreamHeaders, response) {
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = upstreamHeaders.get(name);

    if (value) {
      response.setHeader(name, value);
    }
  }

  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
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

  if (nextPath.startsWith('/__route/')) {
    return '/';
  }

  return nextPath;
}

function normalizeRequestPath(rawPath) {
  const path = typeof rawPath === 'string' ? rawPath : '/';

  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) {
    return '/';
  }

  return path;
}

function readHeader(headers, name) {
  if (typeof headers?.get === 'function') {
    return headers.get(name) || '';
  }

  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || '');
}
