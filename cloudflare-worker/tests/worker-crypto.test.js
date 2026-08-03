import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWorkerPasswordHash,
  createWorkerSessionToken,
  parseWorkerSessionTtl,
  verifyWorkerPassword,
  verifyWorkerSessionToken
} from '../src/worker-crypto.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const NOW = Date.UTC(2026, 6, 30);

test('creates a Workers-compatible peppered HMAC project password', async () => {
  const hash = await createWorkerPasswordHash('project-password', {
    secret: SECRET,
    salt: new TextEncoder().encode('0123456789abcdef')
  });

  assert.match(hash, /^hmac-sha256\$/);
  assert.equal(await verifyWorkerPassword('project-password', hash, SECRET), true);
  assert.equal(await verifyWorkerPassword('wrong-password', hash, SECRET), false);
  assert.equal(
    await verifyWorkerPassword(
      'project-password',
      hash,
      'fedcba9876543210fedcba9876543210'
    ),
    false
  );
});

test('creates an expiring alias-bound Worker session', async () => {
  const token = await createWorkerSessionToken('docs-a7f3', SECRET, {
    now: NOW,
    ttlSeconds: 600
  });

  assert.equal(
    await verifyWorkerSessionToken(token, 'docs-a7f3', SECRET, { now: NOW + 1000 }),
    true
  );
  assert.equal(
    await verifyWorkerSessionToken(token, 'admin-k9m2', SECRET, { now: NOW + 1000 }),
    false
  );
  assert.equal(
    await verifyWorkerSessionToken(token, 'docs-a7f3', SECRET, { now: NOW + 601000 }),
    false
  );
});

test('validates Worker session lifetime settings', () => {
  assert.equal(parseWorkerSessionTtl(undefined), 28800);
  assert.equal(parseWorkerSessionTtl('600'), 600);
  assert.throws(() => parseWorkerSessionTtl('60'), TypeError);
});
