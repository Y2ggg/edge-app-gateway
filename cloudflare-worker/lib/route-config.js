const ROUTE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
const SECRET_BINDING_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_ROUTE_COUNT = 200;
const DEFAULT_ENTRY_SESSION_TTL_SECONDS = 1800;
const MIN_ENTRY_SESSION_TTL_SECONDS = 300;
const MAX_ENTRY_SESSION_TTL_SECONDS = 86400;
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

/**
 * Resolve the application that should receive requests sent to the bare
 * ROUTE_BASE_DOMAIN (the gateway's unified entry host).
 *
 * The bare base-domain route is opt-in. An alias must be configured explicitly
 * so adding a new entryAccess relationship can never silently expose a new
 * public host.
 */
export function resolveUnifiedEntryAlias(projects) {
  if (!(projects instanceof Map)) {
    throw new RouteConfigurationError('Projects must be a Map');
  }

  const entries = [...projects]
    .filter(([, project]) => project.isUnifiedEntry === true);

  if (entries.length > 1) {
    throw new RouteConfigurationError('只能配置一个统一入口应用');
  }

  const [semanticAlias, project] = entries[0] || [];
  return project ? semanticAlias : '';
}

export function getProjectHostnameAlias(semanticAlias, project) {
  if (project && Object.prototype.hasOwnProperty.call(project, 'hostnameAlias')) {
    return project.hostnameAlias;
  }
  if (project?.isUnifiedEntry === true) return '';
  // Keep reading pre-role configurations during a gradual migration. New
  // configurations always persist hostnameAlias explicitly for ordinary apps.
  return project?.isUnifiedEntry === undefined ? semanticAlias : '';
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

  validateProjectIdentity(projects);
  validateEntryAccessRelationships(projects);

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
  const isUnifiedEntry = project.isUnifiedEntry === true;
  if (project.isUnifiedEntry !== undefined && typeof project.isUnifiedEntry !== 'boolean') {
    throw new RouteConfigurationError(`Application ${alias} isUnifiedEntry must be boolean`);
  }
  const hostnameAlias = project.hostnameAlias === undefined
    ? ''
    : project.hostnameAlias;
  if (typeof hostnameAlias !== 'string') {
    throw new RouteConfigurationError(`Application ${alias} hostnameAlias must be a string`);
  }
  if (hostnameAlias && !isValidRouteAlias(hostnameAlias)) {
    throw new RouteConfigurationError(`Application ${alias} hostnameAlias must be a valid route alias`);
  }
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
  const entryAccess = parseEntryAccess(alias, project.entryAccess);
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

  const normalized = {
    target,
    deliveryMode,
    proxyProfile,
    requestOriginPolicy,
    edgeAccess,
    entryAccess,
    originProtection,
    allowedMethods,
    cachePolicy,
    cookieDomainPolicy
  };

  if (project.isUnifiedEntry !== undefined) normalized.isUnifiedEntry = isUnifiedEntry;
  if (project.hostnameAlias !== undefined) normalized.hostnameAlias = hostnameAlias;
  if (project.semanticAlias !== undefined) {
    if (project.semanticAlias !== alias || !isValidRouteAlias(project.semanticAlias)) {
      throw new RouteConfigurationError(`Application ${alias} semanticAlias must match its route key`);
    }
    normalized.semanticAlias = project.semanticAlias;
  }

  return Object.freeze(normalized);
}

function validateProjectIdentity(projects) {
  const unifiedEntries = [];
  const hostnameOwners = new Map();

  for (const [semanticAlias, project] of projects) {
    const isUnifiedEntry = project.isUnifiedEntry === true;
    const hostnameAlias = getProjectHostnameAlias(semanticAlias, project);

    if (!isValidRouteAlias(semanticAlias)) {
      throw new RouteConfigurationError(`Application ${semanticAlias} semanticAlias is invalid`);
    }
    if (isUnifiedEntry) unifiedEntries.push(semanticAlias);
    // An explicitly classified ordinary application must declare its public
    // hostname alias. The fallback below only serves legacy configs that did
    // not yet have the isUnifiedEntry field at all.
    if (!isUnifiedEntry && project.isUnifiedEntry === false && !hostnameAlias) {
      throw new RouteConfigurationError(
        `Application ${semanticAlias} requires an alias unless it is the unified entry application`
      );
    }
    if (isUnifiedEntry && project.entryAccess.mode !== 'disabled') {
      throw new RouteConfigurationError(
        `Unified entry application ${semanticAlias} cannot require another entry application`
      );
    }
    if (isUnifiedEntry && project.deliveryMode !== 'proxy') {
      throw new RouteConfigurationError(
        `Unified entry application ${semanticAlias} must use proxy delivery`
      );
    }

    if (hostnameAlias) {
      const existingOwner = hostnameOwners.get(hostnameAlias);
      if (existingOwner && existingOwner !== semanticAlias) {
        throw new RouteConfigurationError(
          `Applications ${existingOwner} and ${semanticAlias} cannot use the same hostname alias ${hostnameAlias}`
        );
      }
      hostnameOwners.set(hostnameAlias, semanticAlias);
    }
  }

  if (unifiedEntries.length > 1) {
    throw new RouteConfigurationError('只能配置一个统一入口应用');
  }
}

function parseEntryAccess(alias, entryAccess) {
  if (entryAccess === undefined) {
    return Object.freeze({ mode: 'disabled' });
  }

  if (entryAccess === null || Array.isArray(entryAccess) || typeof entryAccess !== 'object') {
    throw new RouteConfigurationError(`Application ${alias} entryAccess must be an object`);
  }

  const mode = requireEnum(alias, 'entryAccess.mode', entryAccess.mode, ['disabled', 'required']);

  if (mode === 'disabled') {
    return Object.freeze({ mode });
  }

  const entryAlias = entryAccess.entryAlias;
  const ttlSeconds = entryAccess.ttlSeconds === undefined
    ? DEFAULT_ENTRY_SESSION_TTL_SECONDS
    : entryAccess.ttlSeconds;

  if (!isValidRouteAlias(entryAlias)) {
    throw new RouteConfigurationError(
      `Application ${alias} entryAccess.entryAlias must be a valid route alias`
    );
  }

  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_ENTRY_SESSION_TTL_SECONDS ||
    ttlSeconds > MAX_ENTRY_SESSION_TTL_SECONDS
  ) {
    throw new RouteConfigurationError(
      `Application ${alias} entryAccess.ttlSeconds must be between ${MIN_ENTRY_SESSION_TTL_SECONDS} and ${MAX_ENTRY_SESSION_TTL_SECONDS}`
    );
  }

  return Object.freeze({ mode, entryAlias, ttlSeconds });
}

function validateEntryAccessRelationships(projects) {
  for (const [alias, project] of projects) {
    if (project.entryAccess.mode !== 'required') continue;

    const entryProject = projects.get(project.entryAccess.entryAlias);

    if (!entryProject || project.entryAccess.entryAlias === alias) {
      throw new RouteConfigurationError(
        `Application ${alias} entryAccess.entryAlias must reference another configured application`
      );
    }

    if (project.deliveryMode !== 'proxy' || entryProject.deliveryMode !== 'proxy') {
      throw new RouteConfigurationError(
        `Application ${alias} and its entry application must use proxy delivery`
      );
    }

    if (entryProject.isUnifiedEntry !== true) {
      throw new RouteConfigurationError(
        `Entry application ${project.entryAccess.entryAlias} must be marked as the unified entry application`
      );
    }

    if (entryProject.entryAccess.mode !== 'disabled') {
      throw new RouteConfigurationError(
        `Entry application ${project.entryAccess.entryAlias} cannot require another entry application`
      );
    }
  }
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
