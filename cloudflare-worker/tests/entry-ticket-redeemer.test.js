import assert from 'node:assert/strict';
import test from 'node:test';

import { EntryTicketRedeemer } from '../src/entry-ticket-redeemer.js';

function createState() {
  const values = new Map();
  let alarm = null;
  const storage = {
    async transaction(callback) {
      return callback({
        get: key => values.get(key),
        put: (key, value) => values.set(key, value)
      });
    },
    async setAlarm(value) {
      alarm = value;
    },
    async deleteAll() {
      values.clear();
      alarm = null;
    }
  };

  return {
    state: { storage },
    values,
    readAlarm: () => alarm
  };
}

function consumeRequest(expiresAt) {
  return new Request('https://entry-ticket-redeemer/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresAt })
  });
}

test('atomically accepts a ticket once and schedules its cleanup', async () => {
  const fixture = createState();
  const redeemer = new EntryTicketRedeemer(fixture.state);
  const expiresAt = Date.now() + 30000;

  assert.equal((await redeemer.fetch(consumeRequest(expiresAt))).status, 204);
  assert.equal(fixture.readAlarm(), expiresAt);
  assert.equal((await redeemer.fetch(consumeRequest(expiresAt))).status, 409);

  await redeemer.alarm();
  assert.equal(fixture.values.size, 0);
  assert.equal(fixture.readAlarm(), null);
});

test('rejects malformed, expired and implausibly long ticket lifetimes', async () => {
  const redeemer = new EntryTicketRedeemer(createState().state);

  assert.equal((await redeemer.fetch(new Request('https://entry-ticket-redeemer/consume'))).status, 404);
  assert.equal((await redeemer.fetch(consumeRequest(Date.now() - 1))).status, 400);
  assert.equal((await redeemer.fetch(consumeRequest(Date.now() + 6 * 60 * 1000))).status, 400);
});
