import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareSecretNames,
  parseRemoteSecretNames,
  reconcileRemoteSecrets,
  SecretReconciliationError
} from '../scripts/secret-reconciliation.js';

function secretList(names) {
  return JSON.stringify(names.map(name => ({ name, type: 'secret_text' })));
}

test('compares the complete desired and remote Secret sets', () => {
  assert.deepEqual(
    compareSecretNames(
      ['ROUTE_PROJECTS_JSON', 'ORIGIN_SECRET_REMOVED'],
      ['ROUTE_PROJECTS_JSON', 'ROUTE_SESSION_SECRET']
    ),
    {
      missing: ['ROUTE_SESSION_SECRET'],
      stale: ['ORIGIN_SECRET_REMOVED']
    }
  );
});

test('parses Wrangler Secret output without accepting malformed bindings', () => {
  assert.deepEqual(
    parseRemoteSecretNames(secretList(['ROUTE_SESSION_SECRET', 'ROUTE_PROJECTS_JSON'])),
    ['ROUTE_PROJECTS_JSON', 'ROUTE_SESSION_SECRET']
  );
  assert.throws(
    () => parseRemoteSecretNames('{"secret":"must-not-appear-in-errors"}'),
    error => (
      error instanceof SecretReconciliationError &&
      !error.message.includes('must-not-appear-in-errors')
    )
  );
});

test('deletes stale Secrets only after finding every desired binding and verifies convergence', async () => {
  const calls = [];
  const responses = [
    { exitCode: 0, stdout: secretList(['ROUTE_PROJECTS_JSON', 'ORIGIN_SECRET_REMOVED']) },
    { exitCode: 0, stdout: 'Finished processing secrets file' },
    { exitCode: 0, stdout: secretList(['ROUTE_PROJECTS_JSON']) }
  ];
  const result = await reconcileRemoteSecrets({
    desiredSecretNames: ['ROUTE_PROJECTS_JSON'],
    workerName: 'personal-site',
    runCommand: async (argumentsList, input = '') => {
      calls.push({ argumentsList, input });
      return responses.shift();
    }
  });

  assert.deepEqual(result, { deleted: ['ORIGIN_SECRET_REMOVED'] });
  assert.deepEqual(calls[0], {
    argumentsList: ['secret', 'list', '--name', 'personal-site'],
    input: ''
  });
  assert.deepEqual(calls[1], {
    argumentsList: ['secret', 'bulk', '--name', 'personal-site'],
    input: JSON.stringify({ ORIGIN_SECRET_REMOVED: null })
  });
  assert.deepEqual(calls[2], calls[0]);
});

test('never deletes a stale Secret when the deployed version is missing a desired binding', async () => {
  const calls = [];
  await assert.rejects(
    reconcileRemoteSecrets({
      desiredSecretNames: ['ROUTE_PROJECTS_JSON', 'ROUTE_SESSION_SECRET'],
      workerName: 'lx-cm-route',
      runCommand: async (argumentsList, input = '') => {
        calls.push({ argumentsList, input });
        return {
          exitCode: 0,
          stdout: secretList(['ROUTE_PROJECTS_JSON', 'ORIGIN_SECRET_REMOVED'])
        };
      }
    }),
    /仍缺少 Secret Binding/
  );
  assert.equal(calls.length, 1);
});

test('does not issue a write when the remote Secret set already matches', async () => {
  let callCount = 0;
  const result = await reconcileRemoteSecrets({
    desiredSecretNames: ['ROUTE_PROJECTS_JSON'],
    workerName: 'personal-site',
    runCommand: async () => {
      callCount += 1;
      return { exitCode: 0, stdout: secretList(['ROUTE_PROJECTS_JSON']) };
    }
  });

  assert.deepEqual(result, { deleted: [] });
  assert.equal(callCount, 1);
});
