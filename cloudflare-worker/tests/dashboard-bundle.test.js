import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import dashboardWorker from '../dashboard/worker.js';

const workerSource = await readFile(
  new URL('../dashboard/worker.js', import.meta.url),
  'utf8'
);

test('keeps the Dashboard bundle standalone', () => {
  assert.doesNotMatch(workerSource, /^import\s/m);
  assert.doesNotMatch(workerSource, /ROUTE_PROJECTS_JSON\s*=/);
});

test('runs the Dashboard bundle as a module Worker', async () => {
  const response = await dashboardWorker.fetch(
    new Request('https://route-test.workers.dev/__route/health'),
    {}
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    build: '2026-08-03-route-v2',
    edge: 'local'
  });
});
