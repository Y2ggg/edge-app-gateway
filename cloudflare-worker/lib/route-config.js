const ROUTE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
const SECRET_BINDING_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_ROUTE_COUNT = 200;
const SUPPORTED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const SUPPORTED_METHOD_SET = new Set(SUPPORTED_METHODS);
const FORBIDDEN_ORIGIN_HEADERS = new Set([
  'authorization',
  'cf-connecting-ip',
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-vercel-protection-bypass'
]);

export class RouteConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RouteConfigurationError';
  }
}

export function isValidRouteAlias(alias) {
  return typeof alias === 'string' && ROUTE_ALIAS_PATTERN.test(alias);
}

export function parseRouteProjects(rawConfig) {
  if (typeof rawConfig !== 'string' || rawConfig.length === 0) {
    throw new RouteConfigurationError('ROUTE_PROJECTS_JSON is missing');
  }

  let parsed;

  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    throw new RouteConfigurationError('ROUTE_PROJECTS_JSON must be valid JSON');
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new RouteConfigurationError('ROUTE_PROJECTS_JSON must be an object');
  }

  const entries = Object.entries(parsed);

  if (entries.length === 0 || entries.length > MAX_ROUTE_COUNT) {
    throw new RouteConfigurationError(`Route count must be between 1 and ${MAX_ROUTE_COUNT}`);
  }

  const projects = new Map();

  for (const [alias, rawProject] of entries) {
    projects.set(alias, parseProject(alias, rawProject));
  }

  return projects;
}

function parseProject(alias, project) {
  if (!isValidRouteAlias(alias)) {
    throw new RouteConfigurationError(`Invalid route alias: ${alias}`);
  }

  if (project === null || Array.isArray(project) || typeof project !== 'object') {
    throw new RouteConfigurationError(`Application ${alias} must be an object`);
  }

  const target = parseTarget(alias, project.target);
  const deliveryMode = requireEnum(alias, 'deliveryMode', project.deliveryMode, ['proxy', 'redirect']);
  const proxyProfile = requireEnum(alias, 'proxyProfile', project.proxyProfile, ['static', 'fullstack']);
  const requestOriginPolicy = project.requestOriginPolicy === undefined
    ? 'preserve'
    : requireEnum(
      alias,
      'requestOriginPolicy',
      project.requestOriginPolicy,
      ['preserve', 'rewrite-to-upstream']
    );
  const edgeAccess = parseEdgeAccess(alias, project.edgeAccess);
  const originProtection = parseOriginProtection(alias, project.originProtection);
  const allowedMethods = parseAllowedMethods(alias, project.allowedMethods, proxyProfile);
  const cachePolicy = project.cachePolicy === undefined
    ? 'no-store'
    : requireEnum(alias, 'cachePolicy', project.cachePolicy, ['assets-only', 'no-store']);
  const cookieDomainPolicy = project.cookieDomainPolicy === undefined
    ? 'strip'
    : requireEnum(alias, 'cookieDomainPolicy', project.cookieDomainPolicy, ['strip', 'rewrite']);

  if (deliveryMode === 'redirect' && originProtection.mode === 'required') {
    throw new RouteConfigurationError(
      `Application ${alias} cannot require origin protection in redirect mode`
    );
  }

  if (deliveryMode === 'redirect' && requestOriginPolicy !== 'preserve') {
    throw new RouteConfigurationError(
      `Application ${alias} cannot rewrite request origins in redirect mode`
    );
  }

  if (deliveryMode === 'redirect' && allowedMethods.some(method => !['GET', 'HEAD'].includes(method))) {
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
  if (typeof target !== 'string' || !target) {
    throw new RouteConfigurationError(`Application ${alias} requires a target string`);
  }

  let targetUrl;

  try {
    targetUrl = new URL(target);
  } catch {
    throw new RouteConfigurationError(`Target for ${alias} must be a valid URL`);
  }

  if (
    targetUrl.protocol !== 'https:' ||
    targetUrl.username ||
    targetUrl.password ||
    targetUrl.search ||
    targetUrl.hash
  ) {
    throw new RouteConfigurationError(
      `Target for ${alias} must be a credential-free HTTPS URL without a query or fragment`
    );
  }

  if (!targetUrl.hostname.endsWith('.vercel.app')) {
    throw new RouteConfigurationError(`Target for ${alias} must be hosted under vercel.app`);
  }

  return targetUrl.toString();
}

function parseEdgeAccess(alias, edgeAccess) {
  if (edgeAccess === null || Array.isArray(edgeAccess) || typeof edgeAccess !== 'object') {
    throw new RouteConfigurationError(`Application ${alias} requires edgeAccess configuration`);
  }

  const mode = requireEnum(alias, 'edgeAccess.mode', edgeAccess.mode, ['disabled', 'required']);

  if (mode === 'required') {
    if (typeof edgeAccess.passwordHash !== 'string' || !edgeAccess.passwordHash) {
      throw new RouteConfigurationError(
        `Application ${alias} requires edgeAccess.passwordHash when Edge Access is required`
      );
    }

    return Object.freeze({ mode, passwordHash: edgeAccess.passwordHash });
  }

  return Object.freeze({ mode });
}

function parseOriginProtection(alias, originProtection) {
  if (
    originProtection === null ||
    Array.isArray(originProtection) ||
    typeof originProtection !== 'object'
  ) {
    throw new RouteConfigurationError(`Application ${alias} requires originProtection configuration`);
  }

  const mode = requireEnum(
    alias,
    'originProtection.mode',
    originProtection.mode,
    ['disabled', 'required']
  );

  if (mode === 'disabled') {
    return Object.freeze({ mode });
  }

  const headerName = String(originProtection.headerName || '').toLowerCase();
  const secretBinding = originProtection.secretBinding;

  if (
    !headerName.startsWith('x-') ||
    !HEADER_NAME_PATTERN.test(headerName) ||
    FORBIDDEN_ORIGIN_HEADERS.has(headerName)
  ) {
    throw new RouteConfigurationError(
      `Application ${alias} originProtection.headerName is invalid or unsafe`
    );
  }

  if (typeof secretBinding !== 'string' || !SECRET_BINDING_PATTERN.test(secretBinding)) {
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
    const method = typeof rawMethod === 'string' ? rawMethod.toUpperCase() : '';

    if (!SUPPORTED_METHOD_SET.has(method)) {
      throw new RouteConfigurationError(`Application ${alias} contains an unsupported HTTP method`);
    }

    if (methods.includes(method)) {
      throw new RouteConfigurationError(`Application ${alias} contains a duplicate HTTP method`);
    }

    methods.push(method);
  }

  if (proxyProfile === 'static' && methods.some(method => !['GET', 'HEAD', 'OPTIONS'].includes(method))) {
    throw new RouteConfigurationError(
      `Application ${alias} static profile cannot enable write methods`
    );
  }

  return Object.freeze(SUPPORTED_METHODS.filter(method => methods.includes(method)));
}

function requireEnum(alias, name, value, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new RouteConfigurationError(
      `Application ${alias} ${name} must be one of: ${allowedValues.join(', ')}`
    );
  }

  return value;
}
