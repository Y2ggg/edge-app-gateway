import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import dashboardWorker, { EntryTicketRedeemer } from '../dashboard/worker.js';

const workerSource = await readFile(
  new URL('../dashboard/worker.js', import.meta.url),
  'utf8'
);
const wranglerConfig = JSON.parse(await readFile(
  new URL('../wrangler.jsonc', import.meta.url),
  'utf8'
));

test('keeps the Dashboard bundle standalone', () => {
  assert.doesNotMatch(workerSource, /^import\s/m);
  assert.doesNotMatch(workerSource, /ROUTE_PROJECTS_JSON\s*=/);
  assert.equal(typeof EntryTicketRedeemer, 'function');
  assert.deepEqual(wranglerConfig.durable_objects.bindings, [{
    name: 'ENTRY_TICKET_REDEEMER',
    class_name: 'EntryTicketRedeemer'
  }]);
  assert.deepEqual(wranglerConfig.migrations, [{
    tag: 'v1',
    new_sqlite_classes: ['EntryTicketRedeemer']
  }]);
});

test('runs the Dashboard bundle as a module Worker', async () => {
  const response = await dashboardWorker.fetch(
    new Request('https://gateway.example.com/_edge-gateway/health'),
    {
      ROUTE_PROJECTS_JSON: JSON.stringify({
        'gateway-a7f3': {
          target: 'https://gateway-project.vercel.app',
          deliveryMode: 'proxy',
          proxyProfile: 'fullstack',
          requestOriginPolicy: 'preserve',
          edgeAccess: { mode: 'disabled' },
          entryAccess: { mode: 'disabled' },
          originProtection: { mode: 'disabled' },
          allowedMethods: ['GET', 'HEAD'],
          cachePolicy: 'no-store',
          cookieDomainPolicy: 'strip'
        }
      })
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    build: '2026-08-27-gateway-v9',
    edge: 'local'
  });
});
