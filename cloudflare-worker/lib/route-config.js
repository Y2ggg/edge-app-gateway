const ROUTE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
const MAX_ROUTE_COUNT = 200;

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

  for (const [alias, project] of entries) {
    if (!isValidRouteAlias(alias)) {
      throw new RouteConfigurationError(`Invalid route alias: ${alias}`);
    }

    if (project === null || Array.isArray(project) || typeof project !== 'object') {
      throw new RouteConfigurationError(`Application ${alias} must be an object`);
    }

    const { target, passwordHash, rewriteOrigins = false } = project;

    if (typeof target !== 'string' || typeof passwordHash !== 'string' || !passwordHash) {
      throw new RouteConfigurationError(`Application ${alias} requires target and passwordHash strings`);
    }

    if (typeof rewriteOrigins !== 'boolean') {
      throw new RouteConfigurationError(`Application ${alias} rewriteOrigins must be a boolean`);
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

    projects.set(alias, Object.freeze({
      target: targetUrl.toString(),
      passwordHash,
      rewriteOrigins
    }));
  }

  return projects;
}
