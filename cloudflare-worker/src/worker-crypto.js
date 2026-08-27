const encoder = new TextEncoder();
const PASSWORD_KEY_BYTES = 32;
const MINIMUM_SECRET_LENGTH = 32;
const PASSWORD_HASH_PREFIX = 'hmac-sha256';
const PASSWORD_MESSAGE_PREFIX = 'route-password-v1\0';
const ENTRY_HANDOFF_KIND = 'entry-handoff-v1';
const ENTRY_SESSION_KIND = 'entry-session-v1';
const ENTRY_TOKEN_PREFIX = 'e2';
const ENTRY_TOKEN_MESSAGE_PREFIX = 'route-entry-v2';
const ENTRY_TOKEN_NONCE_BYTES = 16;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;

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
    throw new TypeError('Application passwordHash must use the hmac-sha256 format');
  }

  const salt = base64UrlToBytes(saltText);
  const expectedHash = base64UrlToBytes(hashText);

  if (salt.length < 16 || expectedHash.length !== PASSWORD_KEY_BYTES) {
    throw new TypeError('Application passwordHash has invalid key material');
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

export function createEntryHandoffToken(entryAlias, targetAlias, secret, options = {}) {
  return createEntryToken(ENTRY_HANDOFF_KIND, entryAlias, targetAlias, secret, {
    ...options,
    ttlSeconds: options.ttlSeconds ?? 30
  });
}

export function verifyEntryHandoffToken(token, entryAlias, targetAlias, secret, options = {}) {
  return verifyEntryToken(token, ENTRY_HANDOFF_KIND, entryAlias, targetAlias, secret, options);
}

export function createEntrySessionToken(entryAlias, targetAlias, secret, options = {}) {
  return createEntryToken(ENTRY_SESSION_KIND, entryAlias, targetAlias, secret, options);
}

export function verifyEntrySessionToken(token, entryAlias, targetAlias, secret, options = {}) {
  return verifyEntryToken(token, ENTRY_SESSION_KIND, entryAlias, targetAlias, secret, options);
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

async function createEntryToken(kind, entryAlias, targetAlias, secret, options) {
  validateSecret(secret);
  validateTokenAlias(entryAlias);
  validateTokenAlias(targetAlias);

  const ttlSeconds = options.ttlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('Entry token lifetime must be a positive integer');
  }

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const expiresAt = nowSeconds + ttlSeconds;
  const nonceBytes = options.nonce ?? crypto.getRandomValues(
    new Uint8Array(ENTRY_TOKEN_NONCE_BYTES)
  );

  if (!(nonceBytes instanceof Uint8Array) || nonceBytes.length !== ENTRY_TOKEN_NONCE_BYTES) {
    throw new TypeError(`Entry token nonce must contain ${ENTRY_TOKEN_NONCE_BYTES} bytes`);
  }

  const nonce = bytesToBase64Url(nonceBytes);
  const signature = await sign(
    entryTokenMessage(kind, entryAlias, targetAlias, expiresAt, nonce, options.binding),
    secret
  );
  return `${ENTRY_TOKEN_PREFIX}.${expiresAt}.${nonce}.${signature}`;
}

async function verifyEntryToken(token, kind, entryAlias, targetAlias, secret, options) {
  validateSecret(secret);
  validateTokenAlias(entryAlias);
  validateTokenAlias(targetAlias);

  const [prefix, expiresText, nonce, providedSignature, ...extra] = String(token || '').split('.');
  if (
    prefix !== ENTRY_TOKEN_PREFIX ||
    !/^\d+$/.test(expiresText || '') ||
    !BASE64_URL_PATTERN.test(nonce || '') ||
    !BASE64_URL_PATTERN.test(providedSignature || '') ||
    extra.length > 0
  ) {
    return false;
  }

  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || String(expiresAt) !== expiresText) return false;

  try {
    if (base64UrlToBytes(nonce).length !== ENTRY_TOKEN_NONCE_BYTES) return false;
  } catch {
    return false;
  }

  const expectedSignature = await sign(
    entryTokenMessage(kind, entryAlias, targetAlias, expiresAt, nonce, options.binding),
    secret
  );
  if (!constantTimeEqual(
    encoder.encode(providedSignature),
    encoder.encode(expectedSignature)
  )) {
    return false;
  }

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  return expiresAt > nowSeconds;
}

function entryTokenMessage(kind, entryAlias, targetAlias, expiresAt, nonce, binding) {
  const parts = [
    ENTRY_TOKEN_MESSAGE_PREFIX,
    kind,
    entryAlias,
    targetAlias,
    String(expiresAt),
    nonce
  ];

  if (binding !== undefined) {
    validateTokenBinding(binding);
    parts.push(binding);
  }

  return parts.join('\0');
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

function validateTokenAlias(alias) {
  if (typeof alias !== 'string' || alias.length === 0 || alias.length > 63) {
    throw new TypeError('Entry token aliases must contain between 1 and 63 characters');
  }
}

function validateTokenBinding(binding) {
  if (typeof binding !== 'string' || binding.length === 0 || binding.length > 4096) {
    throw new TypeError('Entry token binding must contain between 1 and 4096 characters');
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
