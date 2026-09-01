import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import {
  createWorkerInstanceConfig,
  deriveRateLimitNamespaceId,
  resolveRateLimitNamespaceId
} from '../scripts/worker-instance-config.js';

test('derives stable account-level rate limiter namespaces per Worker', () => {
  assert.equal(deriveRateLimitNamespaceId('lx-cm-route'), '1001');
  assert.equal(deriveRateLimitNamespaceId('personal-site'), '1545396235');
  assert.notEqual(
    deriveRateLimitNamespaceId('personal-site'),
    deriveRateLimitNamespaceId('another-gateway')
  );
  assert.equal(resolveRateLimitNamespaceId(undefined, 'personal-site'), '1545396235');
  assert.equal(resolveRateLimitNamespaceId('2002', 'personal-site'), '2002');
  assert.throws(
    () => resolveRateLimitNamespaceId('0', 'personal-site'),
    /1–2147483647/
  );
});

test('creates a private temporary Wrangler config for one isolated Worker', async () => {
  const temporaryConfig = await createWorkerInstanceConfig('personal-site', '1545396235');

  try {
    const config = JSON.parse(await readFile(temporaryConfig.path, 'utf8'));
    assert.equal(config.name, 'personal-site');
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.ratelimits[0].name, 'EDGE_LOGIN_RATE_LIMITER');
    assert.equal(config.ratelimits[0].namespace_id, '1545396235');
    assert.equal(config.durable_objects.bindings[0].name, 'ENTRY_TICKET_REDEEMER');
    assert.match(config.main, /\/src\/worker\.js$/);
    assert.equal(config.$schema, undefined);
  } finally {
    await rm(temporaryConfig.directory, { recursive: true, force: true });
  }
});
