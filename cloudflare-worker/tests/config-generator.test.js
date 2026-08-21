import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const generatorHtml = await readFile(
  new URL('../tools/config-generator.html', import.meta.url),
  'utf8'
);
const generatorScript = await readFile(
  new URL('../tools/config-generator.js', import.meta.url),
  'utf8'
);

test('keeps the configuration generator offline', () => {
  assert.match(generatorHtml, /id="verify-hostname"/);
  assert.match(generatorHtml, /id="verify-projects"/);
  assert.match(generatorHtml, /id="verify-secret"/);
  assert.match(generatorScript, /async function verifyPassword/);
  assert.match(generatorScript, /crypto\.subtle\.sign/);
  assert.doesNotMatch(generatorHtml + generatorScript, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(generatorScript, /\bfetch\s*\(/);
});

test('builds multiple applications with per-project secrets and domains', () => {
  assert.match(generatorHtml, /id="project-template"/);
  assert.match(generatorHtml, /id="add-project-button"/);
  assert.match(generatorHtml, /生成全部配置/);
  assert.match(generatorScript, /function addProject/);
  assert.match(generatorScript, /for \(const \[index, card\] of cards\.entries\(\)\)/);
  assert.match(generatorScript, /ORIGIN_SECRET_/);
  assert.match(generatorScript, /customDomains = Object\.keys\(projects\)/);
  assert.match(generatorScript, /bindingOwners\.has/);
});

test('imports and exports a versioned variables file without plaintext passwords', () => {
  assert.match(generatorHtml, /id="config-import-input"/);
  assert.match(generatorHtml, /id="config-export-result-button"/);
  assert.match(generatorScript, /edge-app-gateway\.variables/);
  assert.match(generatorScript, /CONFIG_FILE_VERSION = 1/);
  assert.match(generatorScript, /async function importVariablesFile/);
  assert.match(generatorScript, /function exportVariablesFile/);
  assert.match(generatorScript, /new Blob/);
  assert.match(generatorScript, /ROUTE_PROJECTS_JSON/);
  assert.doesNotMatch(generatorScript, /secrets\.password|password:\s*projectField/);
});

test('uses one global generation action for all derived secrets', () => {
  assert.equal((generatorHtml.match(/id="generate-button"/g) || []).length, 1);
  assert.doesNotMatch(generatorHtml, /生成新的 Session Secret|生成该应用登录配置|生成新的 Origin Secret/);
  assert.doesNotMatch(generatorHtml, /data-action="generate-password-hash"|data-action="generate-origin-secret"/);
  assert.match(generatorScript, /async function generateProductionConfiguration/);
  assert.match(generatorScript, /sessionSecret = generateRandomSecret\(\)/);
  assert.match(generatorScript, /originSecret = generateRandomSecret\(\)/);
  assert.match(generatorScript, /passwordHash = await createPasswordHash/);
});

test('preserves imported hashes and never generates silently during export or import', () => {
  assert.match(generatorScript, /继续使用已有 passwordHash/);
  assert.match(generatorScript, /passwordInput\.value = ''/);
  const exportSource = generatorScript.slice(
    generatorScript.indexOf('function exportVariablesFile()'),
    generatorScript.indexOf('async function importVariablesFile')
  );
  const importSource = generatorScript.slice(
    generatorScript.indexOf('async function importVariablesFile'),
    generatorScript.indexOf('function validateVariablesFile')
  );
  assert.doesNotMatch(exportSource, /generateAndRender/);
  assert.doesNotMatch(importSource, /generateAndRender/);
});

test('keeps the workflow compact with steps, master-detail editing and result tabs', () => {
  assert.match(generatorHtml, /id="wizard-step-1"/);
  assert.match(generatorHtml, /id="wizard-step-2"/);
  assert.match(generatorHtml, /id="deployment-result"[^>]*data-step="3"[^>]*hidden/);
  assert.match(generatorHtml, /id="project-list"/);
  assert.match(generatorHtml, /data-result-tab="deployment"/);
  assert.match(generatorHtml, /data-result-tab="waf"/);
  assert.match(generatorHtml, /data-result-tab="raw"/);
  assert.match(generatorScript, /function selectProject/);
  assert.match(generatorScript, /card\.dataset\.active/);
  assert.match(generatorScript, /function activateResultTab/);
});

test('explains CLI and WebDAV-safe ownership of variables', () => {
  assert.match(generatorHtml, /npm run deploy:config/);
  assert.match(generatorHtml, /受控 WebDAV 目录/);
  assert.match(generatorHtml, /不需要 Cloudflare Dashboard/);
  assert.match(generatorHtml, /普通变量：/);
  assert.match(generatorHtml, /Cloudflare Secrets：/);
  assert.match(generatorScript, /--secrets-file \/dev\/stdin/);
  assert.match(generatorScript, /# Secrets（Wrangler --secrets-file/);
});

test('keeps the generator script syntactically valid', () => {
  assert.doesNotThrow(() => new Function(generatorScript));
});
