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
  assert.doesNotMatch(generatorHtml, /id="verify-base-domain"/);
  assert.doesNotMatch(generatorHtml, /id="verify-projects"/);
  assert.doesNotMatch(generatorHtml, /id="verify-secret"/);
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

test('configures signed unified-entry access and produces launch links', () => {
  assert.match(generatorHtml, /data-field="entry-access"/);
  assert.match(generatorHtml, /data-field="entry-alias"/);
  assert.match(generatorHtml, /data-field="entry-ttl"/);
  assert.match(generatorHtml, /不依赖可伪造的 Referer/);
  assert.match(generatorHtml, /data-result-tab="entry"/);
  assert.match(generatorHtml, /id="entry-launch-output"/);
  assert.match(generatorScript, /function syncProjectEntryFields/);
  assert.match(generatorScript, /function validateEntryAccessRelationships/);
  assert.match(generatorScript, /entryAccess,/);
  assert.match(generatorScript, /\/_edge-gateway\/launch/);
  assert.match(generatorScript, /launchUrl\.searchParams\.set\('target'/);
  assert.match(generatorScript, /统一入口.*必须启用 Gateway 密码登录/);
  assert.match(generatorScript, /project\.entryAccess\.mode !== 'required'/);
  assert.match(generatorHtml, /受限 Demo 的健康接口会隐匿为 404/);
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

test('keeps generation and verification as peer tabs', () => {
  assert.match(generatorHtml, /role="tab"[^>]*data-workspace-tab="generator"/);
  assert.match(generatorHtml, /role="tab"[^>]*data-workspace-tab="verification"/);
  assert.match(generatorHtml, /id="generator-workspace"[^>]*data-workspace-panel="generator"/);
  assert.match(generatorHtml, /id="verification-workspace"[^>]*data-workspace-panel="verification"/);
  assert.match(generatorScript, /function showWorkspaceTab/);
  assert.match(generatorScript, /ArrowLeft/);
  assert.match(generatorScript, /ArrowRight/);
});

test('keeps the generator workflow compact with steps, master-detail editing and result tabs', () => {
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

test('verifies a hostname and optional password from the loaded configuration', () => {
  const verificationPanel = generatorHtml.slice(generatorHtml.indexOf('id="verification-workspace"'));
  assert.match(verificationPanel, /id="verify-hostname"/);
  assert.match(verificationPanel, /id="verify-password"/);
  assert.match(verificationPanel, /Gateway 访问密码（可选）/);
  assert.doesNotMatch(verificationPanel, /ROUTE_BASE_DOMAIN|ROUTE_PROJECTS_JSON|ROUTE_SESSION_SECRET/);
  assert.match(generatorScript, /let verificationConfiguration = null/);
  assert.match(generatorScript, /setVerificationConfiguration\(\{/);
  assert.match(generatorScript, /const \{ baseDomain, projects, sessionSecret \} = verificationConfiguration/);
  assert.match(generatorScript, /Edge Access 已禁用/);
  assert.match(generatorScript, /请填写访问密码/);
  assert.match(generatorScript, /密码与 passwordHash 不匹配/);
  assert.match(generatorScript, /passwordInput\.value = ''/);
});

test('generates one repository-root deployment flow with synchronized filenames', () => {
  assert.match(generatorHtml, /请先进入 <code>edge-app-gateway<\/code> 仓库根目录/);
  assert.match(generatorHtml, /id="config-check-command-output"/);
  assert.match(generatorHtml, /id="config-dry-run-command-output"/);
  assert.match(generatorHtml, /id="config-deploy-command-output"/);
  assert.match(generatorHtml, /id="complete-deploy-flow-output"/);
  assert.match(generatorHtml, /data-default-label="复制完整部署流程"/);
  assert.match(generatorHtml, /高级部署方式/);
  assert.match(generatorScript, /const variablesFilePath = `\.\.\/\$\{variablesFileName\}`/);
  assert.match(generatorScript, /npm --prefix cloudflare-worker run deploy:config --/);
  assert.match(generatorScript, /const checkCommand = `\$\{deployCommandPrefix\} --check`/);
  assert.match(generatorScript, /const dryRunCommand = `\$\{deployCommandPrefix\} --dry-run`/);
  assert.match(generatorScript, /chmod 600/);
});

test('provides an independent copy action for every recommended command', () => {
  for (const outputId of [
    'config-check-command-output',
    'config-dry-run-command-output',
    'config-deploy-command-output',
    'verify-command-output',
    'complete-deploy-flow-output'
  ]) {
    assert.match(generatorHtml, new RegExp(`data-copy="${outputId}"`));
  }
});

test('explains CLI and WebDAV-safe ownership of variables', () => {
  assert.match(generatorScript, /npm --prefix cloudflare-worker run deploy:config/);
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
