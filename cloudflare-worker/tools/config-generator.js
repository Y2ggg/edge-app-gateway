const CONFIG_FILE_FORMAT = 'edge-app-gateway.variables';
const CONFIG_FILE_VERSION = 1;
const MAX_CONFIG_FILE_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const supportedMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const forbiddenOriginHeaders = new Set([
  'authorization',
  'cf-connecting-ip',
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-vercel-protection-bypass'
]);

let projectSequence = 0;
let latestGenerated = null;

document.querySelector('#add-project-button').addEventListener('click', () => {
  addProject();
  markOutputsStale();
});

document.querySelector('#generate-button').addEventListener('click', () => {
  generateAndRender({ scroll: true });
});

document.querySelector('#base-domain').addEventListener('input', () => {
  syncAllHostnames();
  markOutputsStale();
});

for (const selector of ['#worker-name', '#session-ttl']) {
  document.querySelector(selector).addEventListener('input', markOutputsStale);
}

document.querySelector('#session-secret').addEventListener('input', () => {
  invalidatePasswordHashes('Session Secret 已修改，请重新生成各应用的登录配置。');
  markOutputsStale();
});

document.querySelector('#session-secret-button').addEventListener('click', () => {
  document.querySelector('#session-secret').value = generateRandomSecret();
  invalidatePasswordHashes('已生成新的 Session Secret，请重新生成各应用的登录配置。');
  setStatus('#session-secret-status', '已生成新的 Session Secret。', false);
  markOutputsStale();
});

document.querySelector('#config-import-input').addEventListener('change', async event => {
  const [file] = event.target.files;
  if (!file) return;

  try {
    await importVariablesFile(file);
  } catch (error) {
    setStatus('#config-file-status', error.message, true);
  } finally {
    event.target.value = '';
  }
});

document.querySelector('#config-export-button').addEventListener('click', exportVariablesFile);
document.querySelector('#config-export-result-button').addEventListener('click', exportVariablesFile);

document.querySelector('#config-new-button').addEventListener('click', () => {
  if (!window.confirm('清空当前页面内的全部应用和 Secret？尚未导出的内容将无法恢复。')) return;
  resetGenerator();
  setStatus('#config-file-status', '已创建空白配置。', false);
});

document.querySelector('#projects-container').addEventListener('input', event => {
  const card = event.target.closest('[data-project]');
  if (!card) return;

  if (event.target.matches('[data-field="alias"]')) syncProjectHostname(card);
  markOutputsStale();
});

document.querySelector('#projects-container').addEventListener('change', event => {
  const card = event.target.closest('[data-project]');
  if (!card) return;

  if (event.target.matches('[data-field="edge-access"]')) syncProjectEdgeFields(card);
  markOutputsStale();
});

document.querySelector('#projects-container').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  const card = button?.closest('[data-project]');
  if (!button || !card) return;

  const action = button.dataset.action;

  if (action === 'remove-project') {
    card.remove();
    if (!document.querySelector('[data-project]')) addProject();
    updateProjectTitles();
    markOutputsStale();
    return;
  }

  if (action === 'generate-origin-secret') {
    projectField(card, 'origin-secret').value = generateRandomSecret();
    const status = card.querySelector('[data-role="origin-secret-status"]');
    status.dataset.error = 'false';
    status.textContent = '已生成，请重新生成部署配置。';
    markOutputsStale();
    return;
  }

  if (action === 'generate-password-hash') {
    await generateProjectPasswordHash(card);
  }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;

  const output = document.querySelector(`#${button.dataset.copy}`);
  const value = output?.value ?? output?.textContent ?? '';
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
  } catch {
    if (typeof output.select === 'function') output.select();
    document.execCommand('copy');
  }

  button.textContent = '已复制';
  window.setTimeout(() => {
    button.textContent = button.dataset.defaultLabel || '复制';
  }, 1200);
});

document.querySelector('#verify-button').addEventListener('click', verifyExistingConfiguration);

addProject();

function addProject(initial = {}) {
  if (document.querySelectorAll('[data-project]').length >= 200) {
    throw new Error('最多只能配置 200 个应用。');
  }

  const fragment = document.querySelector('#project-template').content.cloneNode(true);
  const card = fragment.querySelector('[data-project]');
  card.dataset.projectId = String(++projectSequence);
  const route = initial.route || {};

  projectField(card, 'alias').value = initial.alias || '';
  projectField(card, 'target').value = route.target || '';
  projectField(card, 'edge-access').value = route.edgeAccess?.mode || 'disabled';
  projectField(card, 'password-hash').value = route.edgeAccess?.passwordHash || '';
  projectField(card, 'delivery-mode').value = route.deliveryMode || 'proxy';
  projectField(card, 'proxy-profile').value = route.proxyProfile || 'fullstack';
  projectField(card, 'origin-policy').value = route.requestOriginPolicy || 'rewrite-to-upstream';
  projectField(card, 'origin-protection').value = route.originProtection?.mode || 'required';
  projectField(card, 'cache-policy').value = route.cachePolicy || 'assets-only';
  projectField(card, 'cookie-domain-policy').value = route.cookieDomainPolicy || 'strip';
  projectField(card, 'methods').value = Array.isArray(route.allowedMethods)
    ? route.allowedMethods.join(', ')
    : supportedMethods.join(', ');
  projectField(card, 'origin-header').value = route.originProtection?.headerName || 'x-edge-app-gateway-origin';
  projectField(card, 'secret-binding').value = route.originProtection?.secretBinding || '';
  projectField(card, 'origin-secret').value = initial.originSecret || '';

  if (route.edgeAccess?.passwordHash) {
    const status = card.querySelector('[data-role="password-status"]');
    status.dataset.error = 'false';
    status.textContent = '已从变量文件导入 passwordHash。';
  }

  document.querySelector('#projects-container').append(card);
  syncProjectEdgeFields(card);
  syncProjectHostname(card);
  updateProjectTitles();
  return card;
}

function projectField(card, name) {
  return card.querySelector(`[data-field="${name}"]`);
}

function updateProjectTitles() {
  const cards = [...document.querySelectorAll('[data-project]')];
  for (const [index, card] of cards.entries()) {
    const alias = projectField(card, 'alias').value.trim();
    card.querySelector('[data-role="project-title"]').textContent = alias
      ? `应用 ${index + 1} · ${alias}`
      : `应用 ${index + 1}`;
  }
}

function syncAllHostnames() {
  for (const card of document.querySelectorAll('[data-project]')) syncProjectHostname(card);
}

function syncProjectHostname(card) {
  const alias = projectField(card, 'alias').value.trim().toLowerCase();
  const baseDomain = document.querySelector('#base-domain').value.trim().toLowerCase();
  const output = card.querySelector('[data-role="hostname"]');

  if (!alias || !baseDomain) {
    output.textContent = '等待填写 Alias 和基础域名';
  } else {
    output.textContent = `${alias}.${baseDomain}`;
  }

  updateProjectTitles();
}

function syncProjectEdgeFields(card) {
  const required = projectField(card, 'edge-access').value === 'required';
  card.querySelector('[data-role="edge-fields"]').hidden = !required;
}

function invalidatePasswordHashes(message) {
  for (const card of document.querySelectorAll('[data-project]')) {
    const hash = projectField(card, 'password-hash');
    if (!hash.value) continue;
    hash.value = '';
    const status = card.querySelector('[data-role="password-status"]');
    status.dataset.error = 'true';
    status.textContent = message;
  }
}

async function generateProjectPasswordHash(card) {
  const password = projectField(card, 'password').value;
  const status = card.querySelector('[data-role="password-status"]');
  status.dataset.error = 'true';

  if (!password || password.length > 256) {
    status.textContent = '请输入 1–256 个字符的 Gateway 密码。';
    return;
  }

  let secret = document.querySelector('#session-secret').value.trim();
  if (!secret) {
    secret = generateRandomSecret();
    document.querySelector('#session-secret').value = secret;
    setStatus('#session-secret-status', '已自动生成全局 Session Secret。', false);
  }

  if (secret.length < 32) {
    status.textContent = 'ROUTE_SESSION_SECRET 至少需要 32 个字符。';
    return;
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await passwordDigest(password, salt, secret);
  projectField(card, 'password-hash').value = [
    'hmac-sha256',
    toBase64Url(salt),
    toBase64Url(digest)
  ].join('$');
  status.dataset.error = 'false';
  status.textContent = '登录配置已生成，明文密码不会导出。';
  markOutputsStale();
}

function generateAndRender({ scroll = false } = {}) {
  const status = document.querySelector('#generate-status');
  status.dataset.error = 'true';
  clearProductionOutputs();

  try {
    const generated = generateProductionConfiguration();
    latestGenerated = generated;
    renderGeneratedConfiguration(generated);
    status.dataset.error = 'false';
    status.textContent = `已生成 ${generated.projectCount} 个应用的完整配置。`;
    if (scroll) {
      document.querySelector('#deployment-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return generated;
  } catch (error) {
    status.textContent = error.message;
    return null;
  }
}

function generateProductionConfiguration() {
  const workerName = readValue('#worker-name');
  const baseDomain = parseBaseDomain(readValue('#base-domain'), true);
  const ttlSeconds = Number(readValue('#session-ttl'));
  const cards = [...document.querySelectorAll('[data-project]')];

  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(workerName)) {
    throw new Error('Worker 名称只能包含小写字母、数字、短横线和下划线。');
  }

  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 604800) {
    throw new Error('Session 有效期必须是 300–604800 之间的整数。');
  }

  if (!cards.length || cards.length > 200) {
    throw new Error('应用数量必须是 1–200 个。');
  }

  const projects = {};
  const originSecrets = {};
  const bindingOwners = new Map();
  const wafSecrets = [];
  let requiresSessionSecret = false;

  for (const [index, card] of cards.entries()) {
    const displayIndex = index + 1;
    const alias = projectField(card, 'alias').value.trim();

    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(alias)) {
      throw new Error(`应用 ${displayIndex} 的 Alias 必须是 3–63 位小写字母、数字或短横线。`);
    }

    if (projects[alias]) throw new Error(`Alias“${alias}”重复。`);

    const target = parseTarget(projectField(card, 'target').value.trim());
    const deliveryMode = projectField(card, 'delivery-mode').value;
    const proxyProfile = projectField(card, 'proxy-profile').value;
    const requestOriginPolicy = projectField(card, 'origin-policy').value;
    const edgeAccessMode = projectField(card, 'edge-access').value;
    const originProtectionMode = projectField(card, 'origin-protection').value;
    const cachePolicy = projectField(card, 'cache-policy').value;
    const cookieDomainPolicy = projectField(card, 'cookie-domain-policy').value;
    const allowedMethods = parseAllowedMethods(projectField(card, 'methods').value);

    validateDeliveryOptions({
      deliveryMode,
      proxyProfile,
      requestOriginPolicy,
      originProtectionMode,
      allowedMethods
    });

    const edgeAccess = { mode: edgeAccessMode };
    if (edgeAccessMode === 'required') {
      const passwordHash = projectField(card, 'password-hash').value.trim();
      validatePasswordHash(passwordHash);
      edgeAccess.passwordHash = passwordHash;
      requiresSessionSecret = true;
    } else if (edgeAccessMode !== 'disabled') {
      throw new Error(`应用“${alias}”的 Edge Access 模式无效。`);
    }

    const originProtection = { mode: originProtectionMode };
    const hostname = `${alias}.${baseDomain}`;

    if (originProtectionMode === 'required') {
      const headerName = projectField(card, 'origin-header').value.trim().toLowerCase();
      const defaultBinding = `ORIGIN_SECRET_${alias.replaceAll('-', '_').toUpperCase()}`;
      const secretBinding = projectField(card, 'secret-binding').value.trim() || defaultBinding;
      let originSecret = projectField(card, 'origin-secret').value.trim();

      validateOriginHeader(headerName);
      validateBindingName(secretBinding);

      if (bindingOwners.has(secretBinding)) {
        throw new Error(`应用“${alias}”与“${bindingOwners.get(secretBinding)}”使用了重复的 Secret Binding。`);
      }

      if (!originSecret) {
        originSecret = generateRandomSecret();
        projectField(card, 'origin-secret').value = originSecret;
      }

      if (originSecret.length < 16) {
        throw new Error(`应用“${alias}”的 Origin Secret 至少需要 16 个字符。`);
      }

      projectField(card, 'secret-binding').value = secretBinding;
      bindingOwners.set(secretBinding, alias);
      originProtection.headerName = headerName;
      originProtection.secretBinding = secretBinding;
      originSecrets[secretBinding] = originSecret;
      wafSecrets.push({ alias, hostname, headerName, secretBinding, secret: originSecret });
    } else if (originProtectionMode !== 'disabled') {
      throw new Error(`应用“${alias}”的源站保护模式无效。`);
    }

    projects[alias] = {
      target,
      deliveryMode,
      proxyProfile,
      requestOriginPolicy,
      edgeAccess,
      originProtection,
      allowedMethods,
      cachePolicy,
      cookieDomainPolicy
    };
  }

  const routeJson = JSON.stringify(projects);
  const secrets = { ROUTE_PROJECTS_JSON: routeJson };

  if (requiresSessionSecret) {
    const sessionSecret = readValue('#session-secret');
    if (sessionSecret.length < 32) {
      throw new Error('启用 Edge 登录时，ROUTE_SESSION_SECRET 至少需要 32 个字符。');
    }
    secrets.ROUTE_SESSION_SECRET = sessionSecret;
  }

  Object.assign(secrets, originSecrets);

  const vars = {
    ROUTE_BASE_DOMAIN: baseDomain,
    ROUTE_SESSION_TTL_SECONDS: String(ttlSeconds)
  };
  const customDomains = Object.keys(projects).map(alias => `${alias}.${baseDomain}`);
  const deployArguments = [
    'npx wrangler deploy',
    `  --name ${shellQuote(workerName)}`,
    ...Object.entries(vars).map(([name, value]) => `  --var ${shellQuote(`${name}:${value}`)}`),
    ...customDomains.map(domain => `  --domain ${shellQuote(domain)}`),
    '  --secrets-file /dev/stdin'
  ];
  const variablesFileName = `${workerName}.production.variables.json`;
  const variablesFile = {
    format: CONFIG_FILE_FORMAT,
    version: CONFIG_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    worker: {
      name: workerName,
      customDomains
    },
    vars,
    secrets
  };
  const verifyCommands = [
    `npx wrangler secret list --name ${shellQuote(workerName)}`,
    `npx wrangler deployments list --name ${shellQuote(workerName)}`,
    ...customDomains.map(domain => `curl -fsS ${shellQuote(`https://${domain}/_edge-gateway/health`)}`)
  ].join('\n');
  const environment = [
    '# 普通变量（Wrangler --var）',
    ...Object.entries(vars).map(([name, value]) => `${name}=${value}`),
    '',
    '# Secrets（Wrangler --secrets-file，以下只列名称）',
    ...Object.keys(secrets),
    '',
    '# Custom Domains（Wrangler --domain）',
    ...customDomains
  ].join('\n');

  return {
    workerName,
    projectCount: Object.keys(projects).length,
    routeJson,
    secrets,
    vars,
    customDomains,
    wafSecrets,
    variablesFile,
    variablesFileName,
    environment,
    wranglerCommand: deployArguments.join(' \\\n'),
    configDeployCommand: `npm run deploy:config -- ${shellQuote(variablesFileName)}`,
    verifyCommands
  };
}

function renderGeneratedConfiguration(generated) {
  document.querySelector('#route-json-output').value = generated.routeJson;
  document.querySelector('#secret-bulk-output').value = JSON.stringify(generated.secrets, null, 2);
  document.querySelector('#environment-output').value = generated.environment;
  document.querySelector('#wrangler-command-output').value = generated.wranglerCommand;
  document.querySelector('#config-deploy-command-output').value = generated.configDeployCommand;
  document.querySelector('#verify-command-output').value = generated.verifyCommands;
  document.querySelector('#generated-hostnames').textContent = generated.customDomains.join(', ');
  document.querySelector('#generated-vars').textContent = Object.keys(generated.vars).join(', ');
  document.querySelector('#generated-secret-names').textContent = Object.keys(generated.secrets).join(', ');
  renderWafSecrets(generated.wafSecrets);
  document.querySelector('#waf-step').hidden = generated.wafSecrets.length === 0;
  document.querySelector('#deployment-result').dataset.visible = 'true';
  document.querySelector('#config-export-button').disabled = false;
  document.querySelector('#config-export-result-button').disabled = false;
}

function renderWafSecrets(wafSecrets) {
  const container = document.querySelector('#waf-secrets-output');
  container.replaceChildren();

  for (const [index, item] of wafSecrets.entries()) {
    const card = document.createElement('article');
    card.className = 'waf-card';
    const title = document.createElement('h3');
    title.textContent = `${item.alias} · ${item.hostname}`;
    const description = document.createElement('p');
    description.textContent = `Header：${item.headerName}　Binding：${item.secretBinding}`;
    const output = document.createElement('textarea');
    output.id = `waf-secret-${index + 1}`;
    output.className = 'sensitive';
    output.readOnly = true;
    output.value = item.secret;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.dataset.copy = output.id;
    button.dataset.defaultLabel = `复制 ${item.alias} 的 WAF Secret`;
    button.textContent = button.dataset.defaultLabel;
    card.append(title, description, output, button);
    container.append(card);
  }
}

function markOutputsStale() {
  latestGenerated = null;
  document.querySelector('#deployment-result').dataset.visible = 'false';
  document.querySelector('#config-export-button').disabled = true;
  document.querySelector('#config-export-result-button').disabled = true;
}

function clearProductionOutputs() {
  for (const selector of [
    '#route-json-output',
    '#secret-bulk-output',
    '#environment-output',
    '#wrangler-command-output',
    '#config-deploy-command-output',
    '#verify-command-output'
  ]) {
    document.querySelector(selector).value = '';
  }
  document.querySelector('#waf-secrets-output').replaceChildren();
  document.querySelector('#deployment-result').dataset.visible = 'false';
}

function resetGenerator() {
  document.querySelector('#worker-name').value = 'vercel-route';
  document.querySelector('#base-domain').value = '';
  document.querySelector('#session-ttl').value = '28800';
  document.querySelector('#session-secret').value = '';
  document.querySelector('#projects-container').replaceChildren();
  projectSequence = 0;
  addProject();
  clearProductionOutputs();
  latestGenerated = null;
  document.querySelector('#config-export-button').disabled = true;
  document.querySelector('#config-export-result-button').disabled = true;
  setStatus('#generate-status', '', false);
  setStatus('#session-secret-status', '', false);
}

function exportVariablesFile() {
  const generated = latestGenerated || generateAndRender();
  if (!generated) return;

  const blob = new Blob(
    [JSON.stringify(generated.variablesFile, null, 2)],
    { type: 'application/json;charset=utf-8' }
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = generated.variablesFileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus(
    '#config-file-status',
    `已导出 ${generated.variablesFileName}。文件包含 Secret，请存入受控 WebDAV 目录或密码保险库。`,
    false
  );
}

async function importVariablesFile(file) {
  if (file.size > MAX_CONFIG_FILE_BYTES) {
    throw new Error('变量文件超过 2 MiB，已拒绝导入。');
  }

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('变量文件不是有效 JSON。');
  }

  const imported = validateVariablesFile(parsed);
  document.querySelector('#worker-name').value = imported.workerName;
  document.querySelector('#base-domain').value = imported.baseDomain;
  document.querySelector('#session-ttl').value = String(imported.ttlSeconds);
  document.querySelector('#session-secret').value = imported.sessionSecret;
  document.querySelector('#projects-container').replaceChildren();
  projectSequence = 0;

  for (const project of imported.projects) addProject(project);

  syncAllHostnames();
  const generated = generateAndRender();
  if (!generated) throw new Error('变量文件导入后无法生成有效配置。');

  setStatus(
    '#config-file-status',
    `已导入 ${imported.projects.length} 个应用。Secret 仅保留在当前页面内存中。`,
    false
  );
}

function validateVariablesFile(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('变量文件顶层必须是对象。');
  }

  if (value.format !== CONFIG_FILE_FORMAT || value.version !== CONFIG_FILE_VERSION) {
    throw new Error(`仅支持 ${CONFIG_FILE_FORMAT} v${CONFIG_FILE_VERSION}。`);
  }

  const workerName = String(value.worker?.name || '');
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(workerName)) {
    throw new Error('变量文件中的 Worker 名称无效。');
  }

  const baseDomain = parseBaseDomain(String(value.vars?.ROUTE_BASE_DOMAIN || ''), true);
  const ttlSeconds = Number(value.vars?.ROUTE_SESSION_TTL_SECONDS);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 604800) {
    throw new Error('变量文件中的 Session 有效期无效。');
  }

  const secrets = value.secrets;
  if (!secrets || Array.isArray(secrets) || typeof secrets !== 'object') {
    throw new Error('变量文件缺少 Secrets 对象。');
  }

  for (const [name, secret] of Object.entries(secrets)) {
    validateBindingName(name);
    if (typeof secret !== 'string') throw new Error(`Secret“${name}”必须是字符串。`);
  }

  const projects = parseProjects(secrets.ROUTE_PROJECTS_JSON);
  const entries = Object.entries(projects);
  if (!entries.length || entries.length > 200) throw new Error('变量文件必须包含 1–200 个应用。');

  const importedProjects = [];
  let needsSessionSecret = false;

  for (const [alias, route] of entries) {
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(alias)) {
      throw new Error(`变量文件中的 Alias“${alias}”无效。`);
    }

    validateProject(route);
    let originSecret = '';

    if (route.originProtection.mode === 'required') {
      originSecret = secrets[route.originProtection.secretBinding];
      if (typeof originSecret !== 'string' || originSecret.length < 16) {
        throw new Error(`变量文件缺少应用“${alias}”的 Origin Secret。`);
      }
    }

    if (route.edgeAccess.mode === 'required') needsSessionSecret = true;
    importedProjects.push({ alias, route, originSecret });
  }

  const sessionSecret = String(secrets.ROUTE_SESSION_SECRET || '');
  if (needsSessionSecret && sessionSecret.length < 32) {
    throw new Error('变量文件缺少有效的 ROUTE_SESSION_SECRET。');
  }

  const expectedDomains = entries.map(([alias]) => `${alias}.${baseDomain}`).sort();
  const customDomains = value.worker?.customDomains;
  if (!Array.isArray(customDomains) || customDomains.some(domain => typeof domain !== 'string')) {
    throw new Error('变量文件缺少 Custom Domains 数组。');
  }

  const actualDomains = [...customDomains].sort();
  if (JSON.stringify(actualDomains) !== JSON.stringify(expectedDomains)) {
    throw new Error('变量文件中的 Custom Domains 与 Alias/基础域名不一致。');
  }

  return { workerName, baseDomain, ttlSeconds, sessionSecret, projects: importedProjects };
}

async function verifyExistingConfiguration() {
  const status = document.querySelector('#verify-status');
  status.dataset.error = 'true';
  status.textContent = '正在检查…';

  try {
    const hostname = parseHostname(document.querySelector('#verify-hostname').value);
    const baseDomain = parseBaseDomain(document.querySelector('#verify-base-domain').value, false);
    const projects = parseProjects(document.querySelector('#verify-projects').value);
    const aliases = Object.keys(projects);
    let alias;

    if (baseDomain) {
      if (!hostname.endsWith(`.${baseDomain}`)) {
        throw new Error(`访问域名不属于 ROUTE_BASE_DOMAIN：${baseDomain}`);
      }
      alias = hostname.slice(0, -(baseDomain.length + 1));
    } else if (aliases.length === 1) {
      [alias] = aliases;
    } else {
      throw new Error('多应用配置必须填写 ROUTE_BASE_DOMAIN。');
    }

    const project = projects[alias];
    if (!project) throw new Error(`域名前缀“${alias}”在 ROUTE_PROJECTS_JSON 中不存在。`);
    validateProject(project);

    if (project.edgeAccess.mode === 'disabled') {
      status.dataset.error = 'false';
      status.textContent = `检查通过：域名匹配应用“${alias}”，Edge Access 已禁用。`;
      return;
    }

    const password = document.querySelector('#verify-password').value;
    const secret = document.querySelector('#verify-secret').value;
    const matches = await verifyPassword(password, project.edgeAccess.passwordHash, secret);
    if (!matches) throw new Error(`域名已匹配应用“${alias}”，但密码与 passwordHash 不匹配。`);

    status.dataset.error = 'false';
    status.textContent = `检查通过：域名匹配应用“${alias}”，密码散列有效。`;
  } catch (error) {
    status.textContent = error.message;
  }
}

function validateProject(project) {
  if (!project || Array.isArray(project) || typeof project !== 'object') {
    throw new Error('应用配置必须是对象。');
  }

  parseTarget(project.target);
  const requestOriginPolicy = project.requestOriginPolicy === undefined
    ? 'preserve'
    : project.requestOriginPolicy;

  if (!['disabled', 'required'].includes(project.edgeAccess?.mode)) {
    throw new Error('edgeAccess.mode 必须是 disabled 或 required。');
  }
  if (project.edgeAccess.mode === 'required') validatePasswordHash(project.edgeAccess.passwordHash);
  if (!['disabled', 'required'].includes(project.originProtection?.mode)) {
    throw new Error('originProtection.mode 必须是 disabled 或 required。');
  }
  if (project.originProtection.mode === 'required') {
    validateOriginHeader(String(project.originProtection.headerName || '').toLowerCase());
    validateBindingName(project.originProtection.secretBinding);
  }
  if (!['assets-only', 'no-store'].includes(project.cachePolicy || 'no-store')) {
    throw new Error('cachePolicy 必须是 assets-only 或 no-store。');
  }
  if (!['strip', 'rewrite'].includes(project.cookieDomainPolicy || 'strip')) {
    throw new Error('cookieDomainPolicy 必须是 strip 或 rewrite。');
  }

  const allowedMethods = parseAllowedMethods(
    Array.isArray(project.allowedMethods) ? project.allowedMethods.join(',') : ''
  );
  validateDeliveryOptions({
    deliveryMode: project.deliveryMode,
    proxyProfile: project.proxyProfile,
    requestOriginPolicy,
    originProtectionMode: project.originProtection.mode,
    allowedMethods
  });
}

function validateDeliveryOptions({
  deliveryMode,
  proxyProfile,
  requestOriginPolicy,
  originProtectionMode,
  allowedMethods
}) {
  if (!['proxy', 'redirect'].includes(deliveryMode)) {
    throw new Error('deliveryMode 必须是 proxy 或 redirect。');
  }
  if (!['static', 'fullstack'].includes(proxyProfile)) {
    throw new Error('proxyProfile 必须是 static 或 fullstack。');
  }
  if (!['preserve', 'rewrite-to-upstream'].includes(requestOriginPolicy)) {
    throw new Error('requestOriginPolicy 必须是 preserve 或 rewrite-to-upstream。');
  }
  if (proxyProfile === 'static' && allowedMethods.some(
    method => !['GET', 'HEAD', 'OPTIONS'].includes(method)
  )) {
    throw new Error('纯静态应用不能启用写方法。');
  }
  if (deliveryMode === 'redirect') {
    if (allowedMethods.some(method => !['GET', 'HEAD'].includes(method))) {
      throw new Error('浏览器跳转只能允许 GET 和 HEAD。');
    }
    if (requestOriginPolicy !== 'preserve') {
      throw new Error('浏览器跳转不能使用 Origin 改写策略。');
    }
    if (originProtectionMode !== 'disabled') {
      throw new Error('浏览器跳转不能启用源站保护。');
    }
  }
}

function parseAllowedMethods(rawValue) {
  const requested = String(rawValue || '')
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);

  if (!requested.length || requested.some(method => !supportedMethods.includes(method))) {
    throw new Error('Allowed Methods 包含空值或不受支持的方法。');
  }
  if (new Set(requested).size !== requested.length) {
    throw new Error('Allowed Methods 不能重复。');
  }
  return supportedMethods.filter(method => requested.includes(method));
}

function validatePasswordHash(encodedHash) {
  const [prefix, saltText, hashText, ...extra] = String(encodedHash || '').split('$');
  if (prefix !== 'hmac-sha256' || !saltText || !hashText || extra.length) {
    throw new Error('启用 Edge 登录的应用必须先生成完整 passwordHash。');
  }
}

function validateOriginHeader(headerName) {
  if (
    !headerName.startsWith('x-') ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName) ||
    forbiddenOriginHeaders.has(headerName)
  ) {
    throw new Error('Origin Header 必须是安全的自定义 x- Header。');
  }
}

function validateBindingName(name) {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(String(name || ''))) {
    throw new Error('Secret Binding 必须是大写字母开头的 Binding 名。');
  }
}

function parseTarget(rawValue) {
  let target;
  try {
    target = new URL(rawValue);
  } catch {
    throw new Error('Vercel Production URL 格式无效。');
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !target.hostname.endsWith('.vercel.app')
  ) {
    throw new Error('Target 必须是无凭据、查询和片段的 https://*.vercel.app URL。');
  }
  return target.toString();
}

function parseBaseDomain(rawValue, required) {
  const value = String(rawValue || '').trim().toLowerCase();
  if (!value && !required) return '';
  if (
    !value ||
    value.includes('://') ||
    value.includes('/') ||
    value.includes('*') ||
    value.includes(':') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.includes('..') ||
    !/^[a-z0-9.-]+$/.test(value) ||
    !value.includes('.')
  ) {
    throw new Error('ROUTE_BASE_DOMAIN 必须是有效域名，不能包含协议、端口、路径或通配符。');
  }
  return value;
}

function parseHostname(rawValue) {
  const value = String(rawValue || '').trim().toLowerCase();
  if (!value) throw new Error('请填写正在访问的完整域名。');
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname;
  } catch {
    throw new Error('访问域名格式无效。');
  }
}

function parseProjects(rawValue) {
  let projects;
  try {
    projects = JSON.parse(rawValue);
  } catch {
    throw new Error('ROUTE_PROJECTS_JSON 不是有效 JSON。');
  }
  if (!projects || Array.isArray(projects) || typeof projects !== 'object') {
    throw new Error('ROUTE_PROJECTS_JSON 必须是应用映射对象。');
  }
  return projects;
}

function readValue(selector) {
  return document.querySelector(selector).value.trim();
}

function setStatus(selector, message, isError) {
  const status = document.querySelector(selector);
  status.dataset.error = String(Boolean(isError));
  status.textContent = message;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function generateRandomSecret() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(48)));
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const normalized = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function verifyPassword(password, encodedHash, secret) {
  if (!password || password.length > 256) {
    throw new Error('请输入本次用于登录的明文密码。');
  }
  if (secret.length < 32) {
    throw new Error('请填写当前 Worker 使用的 ROUTE_SESSION_SECRET。');
  }

  const [prefix, saltText, hashText, ...extra] = String(encodedHash || '').split('$');
  if (prefix !== 'hmac-sha256' || extra.length) {
    throw new Error('passwordHash 格式无效。');
  }

  let salt;
  let expected;
  try {
    salt = fromBase64Url(saltText);
    expected = fromBase64Url(hashText);
  } catch {
    throw new Error('passwordHash 的 Base64URL 内容无效。');
  }
  if (salt.length < 16 || expected.length !== 32) {
    throw new Error('passwordHash 被截断或包含无效长度。');
  }

  const actual = await passwordDigest(password, salt, secret);
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual[index] ^ expected[index];
  }
  return difference === 0;
}

async function passwordDigest(password, salt, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const message = `route-password-v1\0${toBase64Url(salt)}\0${password}`;
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}
