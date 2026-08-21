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
  assert.match(generatorSource, /project\.edgeAccess\.passwordHash/);
  assert.match(generatorSource, /originProtection\.mode/);
  assert.match(generatorSource, /requestOriginPolicy/);
  assert.match(generatorSource, /crypto\.subtle\.sign/);
  assert.doesNotMatch(generatorSource, /crypto\.subtle\.deriveBits/);
  assert.doesNotMatch(generatorSource, /\bfetch\s*\(/);
});

test('generates the complete production configuration without writing secrets', () => {
  assert.match(generatorSource, /id="origin-secret-output"/);
  assert.match(generatorSource, /id="route-json-output"/);
  assert.match(generatorSource, /id="secret-bulk-output"/);
  assert.match(generatorSource, /id="environment-output"/);
  assert.match(generatorSource, /id="wrangler-command-output"/);
  assert.match(generatorSource, /function generateProductionConfiguration/);
  assert.match(generatorSource, /--secrets-file \/dev\/stdin/);
  assert.match(generatorSource, /--domain/);
  assert.match(generatorSource, /ORIGIN_SECRET_/);
  assert.doesNotMatch(generatorSource, /localStorage|sessionStorage|indexedDB/);
});

test('keeps the default onboarding form small and explains binding ownership', () => {
  assert.match(generatorSource, /默认只填两个地址/);
  assert.match(generatorSource, /id="route-hostname"/);
  assert.match(generatorSource, /id="route-target"/);
  assert.match(generatorSource, /function deriveGatewayDomain/);
  assert.match(generatorSource, /高级设置（通常不用改）/);
  assert.match(generatorSource, /不需要去 Cloudflare Dashboard 手工添加环境变量/);
  assert.match(generatorSource, /普通变量：/);
  assert.match(generatorSource, /Cloudflare Secrets：/);
  assert.match(generatorSource, /Vercel WAF 使用：/);
});

test('supports merging existing projects and keeps secrets out of the variable summary', () => {
  assert.match(generatorSource, /id="route-existing-projects"/);
  assert.match(generatorSource, /projects\[alias\] = route/);
  assert.match(generatorSource, /for \(const projectAlias of Object\.keys\(projects\)\)/);
  assert.match(generatorSource, /# Secrets（Wrangler --secrets-file 自动配置）/);
  assert.doesNotMatch(generatorSource, /`ROUTE_PROJECTS_JSON=\$\{routeJson\}`/);
});

test('keeps the inline generator script syntactically valid', () => {
  const script = generatorSource.match(/<script>([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});
