const encoder = new TextEncoder();
const PASSWORD_KEY_BYTES = 32;
const MINIMUM_SECRET_LENGTH = 32;
const PASSWORD_HASH_PREFIX = 'hmac-sha256';
const PASSWORD_MESSAGE_PREFIX = 'route-password-v1\0';

export async function createWorkerPasswordHash(password, options = {}) {
  validatePassword(password);
  validateSecret(options.secret);

  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const digest = await passwordDigest(password, salt, options.secret);

  return [
    PASSWORD_HASH_PREFIX,
    bytesToBase64Url(salt),
    bytesToBase64Url(digest)
  ].join('$');
}

export async function verifyWorkerPassword(password, encodedHash, secret) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
    return false;
  }

  validateSecret(secret);
  const [prefix, saltText, hashText, ...extra] = String(encodedHash || '').split('$');

  if (
    prefix !== PASSWORD_HASH_PREFIX ||
    extra.length > 0
  ) {
    throw new TypeError('Project passwordHash must use the hmac-sha256 format');
  }

  const salt = base64UrlToBytes(saltText);
  const expectedHash = base64UrlToBytes(hashText);

  if (salt.length < 16 || expectedHash.length !== PASSWORD_KEY_BYTES) {
    throw new TypeError('Project passwordHash has invalid key material');
  }

  const actualHash = await passwordDigest(password, salt, secret);
  return constantTimeEqual(actualHash, expectedHash);
}

export async function createWorkerSessionToken(alias, secret, options = {}) {
  validateSecret(secret);

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const ttlSeconds = options.ttlSeconds ?? 28800;
  const payload = bytesToBase64Url(
    encoder.encode(JSON.stringify({ alias, exp: nowSeconds + ttlSeconds }))
  );
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

export async function verifyWorkerSessionToken(token, alias, secret, options = {}) {
  validateSecret(secret);

  const [payload, providedSignature, ...extra] = String(token || '').split('.');

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

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  return parsed?.alias === alias && Number.isInteger(parsed.exp) && parsed.exp > nowSeconds;
}

export function parseWorkerSessionTtl(rawValue) {
  if (rawValue === undefined || rawValue === '') {
    return 28800;
  }

  const ttlSeconds = Number(rawValue);

  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 604800) {
    throw new TypeError('ROUTE_SESSION_TTL_SECONDS must be between 300 and 604800');
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
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return new Uint8Array(signature);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
    throw new TypeError('Password must contain between 1 and 256 characters');
  }
}

function validateSecret(secret) {
  if (typeof secret !== 'string' || secret.length < MINIMUM_SECRET_LENGTH) {
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
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  const normalized = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const padding = '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
