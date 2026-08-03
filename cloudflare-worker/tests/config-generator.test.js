import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const generatorSource = await readFile(
  new URL('../tools/config-generator.html', import.meta.url),
  'utf8'
);

test('keeps the configuration validator offline', () => {
  assert.match(generatorSource, /id="verify-hostname"/);
  assert.match(generatorSource, /id="verify-projects"/);
  assert.match(generatorSource, /id="verify-secret"/);
  assert.match(generatorSource, /async function verifyPassword/);
  assert.match(generatorSource, /crypto\.subtle\.sign/);
  assert.doesNotMatch(generatorSource, /crypto\.subtle\.deriveBits/);
  assert.doesNotMatch(generatorSource, /\bfetch\s*\(/);
});
