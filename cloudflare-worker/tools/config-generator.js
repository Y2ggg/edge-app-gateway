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
let verificationConfiguration = null;
let selectedProjectId = null;
let activeStep = 1;

for (const button of document.querySelectorAll('[data-workspace-tab]')) {
  button.addEventListener('click', () => showWorkspaceTab(button.dataset.workspaceTab));
}

document.querySelector('.workspace-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('[data-workspace-tab]')];
  const currentIndex = tabs.indexOf(document.activeElement);
  if (currentIndex < 0) return;

  let targetIndex;
  if (event.key === 'Home') targetIndex = 0;
  else if (event.key === 'End') targetIndex = tabs.length - 1;
  else if (event.key === 'ArrowLeft') targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else targetIndex = (currentIndex + 1) % tabs.length;

  event.preventDefault();
  const target = tabs[targetIndex];
  target.focus();
  showWorkspaceTab(target.dataset.workspaceTab);
});

document.querySelector('#add-project-button').addEventListener('click', () => {
  addProject();
  markOutputsStale();
});

document.querySelector('#generate-button').addEventListener('click', async () => {
  await generateAndRender();
});

for (const button of document.querySelectorAll('[data-step-target]')) {
  button.addEventListener('click', () => showStep(Number(button.dataset.stepTarget)));
}

for (const button of document.querySelectorAll('[data-result-tab]')) {
  button.addEventListener('click', () => activateResultTab(button.dataset.resultTab));
}

document.querySelector('#base-domain').addEventListener('input', () => {
  syncAllHostnames();
  markOutputsStale();
});

for (const selector of ['#worker-name', '#session-ttl']) {
  document.querySelector(selector).addEventListener('input', markOutputsStale);
}

document.querySelector('#session-secret').addEventListener('input', () => {
  invalidatePasswordHashes('Session Secret 已修改，请重新生成全部配置。');
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
  if (event.target.matches('[data-field="entry-access"]')) syncProjectEntryFields(card);
  if (event.target.matches('[data-field="delivery-mode"], [data-field="proxy-profile"], [data-field="origin-protection"]')) {
    syncProjectOptions(card, event.target.dataset.field);
  }
  markOutputsStale();
});

document.querySelector('#projects-container').addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  const card = button?.closest('[data-project]');
  if (!button || !card) return;

  const action = button.dataset.action;

  if (action === 'remove-project') {
    const cards = [...document.querySelectorAll('[data-project]')];
    const removedIndex = cards.indexOf(card);
    card.remove();
    if (!document.querySelector('[data-project]')) addProject();
    const remaining = [...document.querySelectorAll('[data-project]')];
    if (selectedProjectId === card.dataset.projectId) {
      selectProject(remaining[Math.min(removedIndex, remaining.length - 1)]);
    }
    updateProjectTitles();
    markOutputsStale();
  }
});

document.querySelector('#project-list').addEventListener('click', event => {
  const button = event.target.closest('[data-project-select]');
  if (button) selectProject(button.dataset.projectSelect);
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;

  const output = document.querySelector(`#${button.dataset.copy}`);
  const value = output?.value ?? output?.textContent ?? '';
  if (!value) return;

  let copied = false;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(value);
    copied = true;
  } catch {
    const temporaryOutput = document.createElement('textarea');
    temporaryOutput.value = value;
    temporaryOutput.readOnly = true;
    temporaryOutput.style.position = 'fixed';
    temporaryOutput.style.opacity = '0';
    document.body.append(temporaryOutput);
    temporaryOutput.select();
    copied = document.execCommand('copy');
    temporaryOutput.remove();
  }

  button.textContent = copied ? '已复制' : '请手动复制';
  window.setTimeout(() => {
    button.textContent = button.dataset.defaultLabel || '复制';
  }, 1200);
});

document.querySelector('#verification-form').addEventListener('submit', async event => {
  event.preventDefault();
  await verifyExistingConfiguration();
});

addProject();
showStep(1);
showWorkspaceTab('generator');

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
  projectField(card, 'entry-access').value = route.entryAccess?.mode || 'disabled';
  projectField(card, 'entry-alias').value = route.entryAccess?.entryAlias || '';
  projectField(card, 'entry-ttl').value = String(route.entryAccess?.ttlSeconds || 1800);
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
  syncProjectEntryFields(card);
  syncProjectOptions(card);
  syncProjectHostname(card);
  updateProjectTitles();
  selectProject(card);
  return card;
}

function projectField(card, name) {
  return card.querySelector(`[data-field="${name}"]`);
}

function updateProjectTitles() {
  const cards = [...document.querySelectorAll('[data-project]')];
  const list = document.querySelector('#project-list');
  list.replaceChildren();

  if (!cards.some(card => card.dataset.projectId === selectedProjectId)) {
    selectedProjectId = cards[0]?.dataset.projectId || null;
  }

  for (const [index, card] of cards.entries()) {
    const alias = projectField(card, 'alias').value.trim();
    const title = alias || `应用 ${index + 1}`;
    card.querySelector('[data-role="project-title"]').textContent = title;
    card.dataset.active = String(card.dataset.projectId === selectedProjectId);

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.projectSelect = card.dataset.projectId;
    button.setAttribute('role', 'listitem');
    button.setAttribute('aria-current', String(card.dataset.projectId === selectedProjectId));
    const name = document.createElement('strong');
    name.textContent = title;
    const summary = document.createElement('small');
    summary.textContent = alias ? projectHostname(card) : 'Alias 尚未填写';
    button.append(name, summary);
    list.append(button);
  }

  document.querySelector('#project-count').textContent = `${cards.length} 个`;
}

function selectProject(project) {
  const projectId = typeof project === 'string' ? project : project?.dataset.projectId;
  if (!projectId || !document.querySelector(`[data-project-id="${projectId}"]`)) return;
  selectedProjectId = projectId;
  updateProjectTitles();
}

function projectHostname(card) {
  const alias = projectField(card, 'alias').value.trim().toLowerCase();
  const baseDomain = document.querySelector('#base-domain').value.trim().toLowerCase();
  return alias && baseDomain ? `${alias}.${baseDomain}` : '等待基础域名';
}

function syncAllHostnames() {
  for (const card of document.querySelectorAll('[data-project]')) syncProjectHostname(card);
}

function syncProjectHostname(card) {
  const output = card.querySelector('[data-role="hostname"]');
  const hostname = projectHostname(card);
  output.textContent = hostname === '等待基础域名' || !projectField(card, 'alias').value.trim()
    ? '等待填写 Alias 和基础域名'
    : hostname;

  updateProjectTitles();
}

function syncProjectEdgeFields(card) {
  const required = projectField(card, 'edge-access').value === 'required';
  card.querySelector('[data-role="edge-fields"]').hidden = !required;
}

function syncProjectEntryFields(card) {
  const required = projectField(card, 'entry-access').value === 'required';
  card.querySelector('[data-role="entry-fields"]').hidden = !required;
}

function syncProjectOptions(card, changedField = '') {
  const deliveryMode = projectField(card, 'delivery-mode');
  const proxyProfile = projectField(card, 'proxy-profile');
  const originPolicy = projectField(card, 'origin-policy');
  const originProtection = projectField(card, 'origin-protection');
  const methods = projectField(card, 'methods');
  const redirect = deliveryMode.value === 'redirect';

  if (redirect) {
    originPolicy.value = 'preserve';
    originProtection.value = 'disabled';
    methods.value = 'GET, HEAD';
  } else if (changedField === 'proxy-profile') {
    methods.value = proxyProfile.value === 'static'
      ? 'GET, HEAD, OPTIONS'
      : supportedMethods.join(', ');
  } else if (changedField === 'delivery-mode' && proxyProfile.value === 'fullstack') {
    methods.value = supportedMethods.join(', ');
  }

  proxyProfile.disabled = redirect;
  originPolicy.disabled = redirect;
  originProtection.disabled = redirect;
  card.querySelector('[data-role="origin-protection-fields"]').hidden = originProtection.value !== 'required';
}

function showStep(step) {
  if (![1, 2, 3].includes(step)) return;
  if (step === 3 && !latestGenerated) return;
  activeStep = step;

  for (const panel of document.querySelectorAll('[data-step]')) {
    panel.hidden = Number(panel.dataset.step) !== step;
  }
  for (const button of document.querySelectorAll('.wizard-nav [data-step-target]')) {
    const target = Number(button.dataset.stepTarget);
    button.setAttribute('aria-current', target === step ? 'step' : 'false');
    if (target === 3) button.disabled = !latestGenerated;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showWorkspaceTab(name) {
  if (!['generator', 'verification'].includes(name)) return;

  for (const button of document.querySelectorAll('[data-workspace-tab]')) {
    const selected = button.dataset.workspaceTab === name;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('[data-workspace-panel]')) {
    panel.hidden = panel.dataset.workspacePanel !== name;
  }
}

function activateResultTab(name) {
  for (const button of document.querySelectorAll('[data-result-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.resultTab === name));
  }
  for (const panel of document.querySelectorAll('[data-result-panel]')) {
    panel.hidden = panel.dataset.resultPanel !== name;
  }
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

async function createPasswordHash(password, secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await passwordDigest(password, salt, secret);
  return [
    'hmac-sha256',
    toBase64Url(salt),
    toBase64Url(digest)
  ].join('$');
}

async function generateAndRender() {
  const status = document.querySelector('#generate-status');
  const button = document.querySelector('#generate-button');
  status.dataset.error = 'true';
  status.textContent = '正在验证并生成…';
  button.disabled = true;
  button.textContent = '正在生成…';
  latestGenerated = null;
  document.querySelector('#config-export-result-button').disabled = true;
  document.querySelector('.wizard-nav [data-step-target="3"]').disabled = true;
  clearProductionOutputs();

  try {
    const generated = await generateProductionConfiguration();
    latestGenerated = generated;
    renderGeneratedConfiguration(generated);
    setVerificationConfiguration({
      baseDomain: generated.vars.ROUTE_BASE_DOMAIN,
      projects: parseProjects(generated.routeJson),
      sessionSecret: generated.secrets.ROUTE_SESSION_SECRET || '',
      source: '最近生成的完整配置'
    });
    status.dataset.error = 'false';
    status.textContent = `已生成 ${generated.projectCount} 个应用的完整配置。`;
    activateResultTab('deployment');
    showStep(3);
    return generated;
  } catch (error) {
    status.textContent = error.message;
    return null;
  } finally {
    button.disabled = false;
    button.textContent = '生成全部配置';
  }
}

async function generateProductionConfiguration() {
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

  const requiredCards = cards.filter(card => projectField(card, 'edge-access').value === 'required');
  let sessionSecret = readValue('#session-secret');

  if (requiredCards.length && !sessionSecret) {
    const hashWithoutPassword = requiredCards.find(card => (
      projectField(card, 'password-hash').value.trim() && !projectField(card, 'password').value
    ));
    if (hashWithoutPassword) {
      selectProject(hashWithoutPassword);
      throw new Error('已存在 passwordHash，但缺少与它绑定的 Session Secret。请导入原 Secret，或重新输入该应用密码。');
    }
    sessionSecret = generateRandomSecret();
    document.querySelector('#session-secret').value = sessionSecret;
    setStatus('#session-secret-status', '已自动生成全局 Session Secret。', false);
  }

  if (requiredCards.length && sessionSecret.length < 32) {
    throw new Error('启用 Edge 登录时，ROUTE_SESSION_SECRET 至少需要 32 个字符。');
  }

  const projects = {};
  const originSecrets = {};
  const bindingOwners = new Map();
  const wafSecrets = [];

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
    const entryAccessMode = projectField(card, 'entry-access').value;
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
      const passwordInput = projectField(card, 'password');
      const status = card.querySelector('[data-role="password-status"]');
      let passwordHash = projectField(card, 'password-hash').value.trim();

      if (passwordInput.value) {
        if (passwordInput.value.length > 256) {
          selectProject(card);
          status.dataset.error = 'true';
          status.textContent = 'Gateway 密码不能超过 256 个字符。';
          throw new Error(`应用“${alias}”的 Gateway 密码不能超过 256 个字符。`);
        }
        passwordHash = await createPasswordHash(passwordInput.value, sessionSecret);
        projectField(card, 'password-hash').value = passwordHash;
        passwordInput.value = '';
        status.dataset.error = 'false';
        status.textContent = 'passwordHash 已生成，明文密码已从页面清除。';
      } else if (!passwordHash) {
        selectProject(card);
        status.dataset.error = 'true';
        status.textContent = '请输入 Gateway 访问密码。';
        throw new Error(`应用“${alias}”启用了 Edge 登录，请输入 Gateway 访问密码。`);
      } else {
        status.dataset.error = 'false';
        status.textContent = '继续使用已有 passwordHash。';
      }

      validatePasswordHash(passwordHash);
      edgeAccess.passwordHash = passwordHash;
    } else if (edgeAccessMode !== 'disabled') {
      throw new Error(`应用“${alias}”的 Edge Access 模式无效。`);
    }

    const entryAccess = { mode: entryAccessMode };
    if (entryAccessMode === 'required') {
      const entryAlias = projectField(card, 'entry-alias').value.trim();
      const entryTtlSeconds = Number(projectField(card, 'entry-ttl').value);

      if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(entryAlias)) {
        selectProject(card);
        throw new Error(`应用“${alias}”的统一入口 Alias 无效。`);
      }
      if (!Number.isInteger(entryTtlSeconds) || entryTtlSeconds < 300 || entryTtlSeconds > 86400) {
        selectProject(card);
        throw new Error(`应用“${alias}”的入口通行有效期必须是 300–86400 之间的整数。`);
      }

      entryAccess.entryAlias = entryAlias;
      entryAccess.ttlSeconds = entryTtlSeconds;
    } else if (entryAccessMode !== 'disabled') {
      throw new Error(`应用“${alias}”的统一入口模式无效。`);
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
      entryAccess,
      originProtection,
      allowedMethods,
      cachePolicy,
      cookieDomainPolicy
    };
  }

  validateEntryAccessRelationships(projects);

  const routeJson = JSON.stringify(projects);
  const secrets = { ROUTE_PROJECTS_JSON: routeJson };

  if (requiredCards.length) {
    secrets.ROUTE_SESSION_SECRET = sessionSecret;
  }

  Object.assign(secrets, originSecrets);

  const vars = {
    ROUTE_BASE_DOMAIN: baseDomain,
    ROUTE_SESSION_TTL_SECONDS: String(ttlSeconds)
  };
  const customDomains = Object.keys(projects).map(alias => `${alias}.${baseDomain}`);
  const entryLaunchLinks = Object.entries(projects)
    .filter(([, project]) => project.entryAccess.mode === 'required')
    .map(([alias, project]) => {
      const launchUrl = new URL(
        '/_edge-gateway/launch',
        `https://${project.entryAccess.entryAlias}.${baseDomain}`
      );
      launchUrl.searchParams.set('target', `${alias}.${baseDomain}`);
      return { alias, entryAlias: project.entryAccess.entryAlias, url: launchUrl.toString() };
    });
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
  const variablesFilePath = `../${variablesFileName}`;
  const deployCommandPrefix = [
    'npm --prefix cloudflare-worker run deploy:config --',
    shellQuote(variablesFilePath)
  ].join(' ');
  const checkCommand = `${deployCommandPrefix} --check`;
  const dryRunCommand = `${deployCommandPrefix} --dry-run`;
  const deployCommand = deployCommandPrefix;
  const healthCheckDomains = Object.entries(projects)
    .filter(([, project]) => project.entryAccess.mode !== 'required')
    .map(([alias]) => `${alias}.${baseDomain}`);
  const healthCheckCommands = healthCheckDomains
    .map(domain => `curl -fsS ${shellQuote(`https://${domain}/_edge-gateway/health`)}`)
    .join('\n');
  const advancedInspectionCommands = [
    'cd cloudflare-worker',
    `npx wrangler whoami`,
    `npx wrangler secret list --name ${shellQuote(workerName)}`,
    `npx wrangler deployments list --name ${shellQuote(workerName)}`
  ].join('\n');
  const completeDeployFlow = [
    '# 执行位置：edge-app-gateway 仓库根目录',
    '# 变量文件包含生产 Secret，建议限制文件权限',
    `chmod 600 ${shellQuote(variablesFileName)}`,
    '',
    '# 校验（仅本地，不访问 Cloudflare）',
    checkCommand,
    '',
    '# Dry-run（不正式部署）',
    dryRunCommand,
    '',
    '# 正式部署',
    deployCommand,
    '',
    '# 健康检查',
    healthCheckCommands
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
    entryLaunchLinks,
    wafSecrets,
    variablesFile,
    variablesFileName,
    environment,
    wranglerCommand: deployArguments.join(' \\\n'),
    checkCommand,
    dryRunCommand,
    deployCommand,
    healthCheckCommands,
    advancedInspectionCommands,
    completeDeployFlow
  };
}

function renderGeneratedConfiguration(generated) {
  document.querySelector('#route-json-output').value = generated.routeJson;
  document.querySelector('#secret-bulk-output').value = JSON.stringify(generated.secrets, null, 2);
  document.querySelector('#environment-output').value = generated.environment;
  document.querySelector('#wrangler-command-output').value = generated.wranglerCommand;
  document.querySelector('#config-check-command-output').value = generated.checkCommand;
  document.querySelector('#config-dry-run-command-output').value = generated.dryRunCommand;
  document.querySelector('#config-deploy-command-output').value = generated.deployCommand;
  document.querySelector('#verify-command-output').value = generated.healthCheckCommands;
  document.querySelector('#advanced-inspection-output').value = generated.advancedInspectionCommands;
  document.querySelector('#complete-deploy-flow-output').value = generated.completeDeployFlow;
  document.querySelector('#entry-launch-output').value = generated.entryLaunchLinks
    .map(item => `${item.alias}: ${item.url}`)
    .join('\n');
  document.querySelector('#generated-hostnames').textContent = generated.customDomains.join(', ');
  document.querySelector('#generated-vars').textContent = Object.keys(generated.vars).join(', ');
  document.querySelector('#generated-secret-names').textContent = Object.keys(generated.secrets).join(', ');
  renderWafSecrets(generated.wafSecrets);
  document.querySelector('#waf-empty').hidden = generated.wafSecrets.length !== 0;
  document.querySelector('#entry-empty').hidden = generated.entryLaunchLinks.length !== 0;
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
  markVerificationConfigurationStale();
  document.querySelector('#config-export-result-button').disabled = true;
  const resultStepButton = document.querySelector('.wizard-nav [data-step-target="3"]');
  if (resultStepButton) resultStepButton.disabled = true;
  if (activeStep === 3) showStep(2);
}

function clearProductionOutputs() {
  for (const selector of [
    '#route-json-output',
    '#secret-bulk-output',
    '#environment-output',
    '#wrangler-command-output',
    '#config-check-command-output',
    '#config-dry-run-command-output',
    '#config-deploy-command-output',
    '#verify-command-output',
    '#advanced-inspection-output',
    '#entry-launch-output',
    '#complete-deploy-flow-output'
  ]) {
    document.querySelector(selector).value = '';
  }
  document.querySelector('#waf-secrets-output').replaceChildren();
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
  setVerificationConfiguration(null);
  document.querySelector('#verify-hostname').value = '';
  document.querySelector('#config-export-result-button').disabled = true;
  document.querySelector('.wizard-nav [data-step-target="3"]').disabled = true;
  setStatus('#generate-status', '', false);
  setStatus('#session-secret-status', '', false);
  setStatus('#export-status', '', false);
  showStep(1);
}

function exportVariablesFile() {
  const generated = latestGenerated;
  if (!generated) {
    setStatus('#export-status', '配置已变更，请返回应用步骤重新生成。', true);
    return;
  }

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
    '#export-status',
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
  selectProject(document.querySelector('[data-project]'));
  markOutputsStale();
  setVerificationConfiguration({
    baseDomain: imported.baseDomain,
    projects: Object.fromEntries(imported.projects.map(project => [project.alias, project.route])),
    sessionSecret: imported.sessionSecret,
    source: `已导入的变量文件（${imported.projects.length} 个应用）`
  });

  setStatus(
    '#config-file-status',
    `已导入 ${imported.projects.length} 个应用。Secret 仅保留在当前页面内存中。`,
    false
  );
  setStatus(
    '#generate-status',
    `已导入 ${imported.projects.length} 个应用，请检查后生成全部配置。`,
    false
  );
  showStep(2);
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

  validateEntryAccessRelationships(projects);

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
  const passwordInput = document.querySelector('#verify-password');
  status.dataset.error = 'true';
  status.textContent = '正在检查…';

  try {
    if (!verificationConfiguration) {
      throw new Error('尚未载入可验证的配置，请先在“配置生成器”中导入变量文件或生成完整配置。');
    }

    const hostname = parseHostname(document.querySelector('#verify-hostname').value);
    const { baseDomain, projects, sessionSecret } = verificationConfiguration;

    if (!hostname.endsWith(`.${baseDomain}`)) {
      throw new Error(`访问域名不属于当前配置的基础域名：${baseDomain}`);
    }
    const alias = hostname.slice(0, -(baseDomain.length + 1));

    const project = projects[alias];
    if (!project) throw new Error(`当前配置中不存在域名前缀“${alias}”对应的应用。`);
    validateProject(project);
    validateEntryAccessRelationships(projects);

    const entryMessage = project.entryAccess?.mode === 'required'
      ? `，且必须从统一入口“${project.entryAccess.entryAlias}”进入`
      : '';

    if (project.edgeAccess.mode === 'disabled') {
      status.dataset.error = 'false';
      status.textContent = `检查通过：域名匹配应用“${alias}”，Edge Access 已禁用${entryMessage}。`;
      return;
    }

    const password = passwordInput.value;
    if (!password) throw new Error(`应用“${alias}”启用了 Gateway 密码登录，请填写访问密码。`);
    const matches = await verifyPassword(password, project.edgeAccess.passwordHash, sessionSecret);
    if (!matches) throw new Error(`域名已匹配应用“${alias}”，但密码与 passwordHash 不匹配。`);

    status.dataset.error = 'false';
    status.textContent = `检查通过：域名匹配应用“${alias}”，密码散列有效${entryMessage}。`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    passwordInput.value = '';
  }
}

function setVerificationConfiguration(configuration) {
  const context = document.querySelector('#verification-context');
  document.querySelector('#verify-password').value = '';
  setStatus('#verify-status', '', false);

  if (!configuration) {
    verificationConfiguration = null;
    context.textContent = '尚未载入可验证的配置，请先在“配置生成器”中导入变量文件或生成完整配置。';
    return;
  }

  verificationConfiguration = { ...configuration, stale: false };
  context.textContent = `校验来源：${configuration.source}。配置和 Secret 自动从当前页面内存读取。`;
}

function markVerificationConfigurationStale() {
  if (!verificationConfiguration || verificationConfiguration.stale) return;
  verificationConfiguration.stale = true;
  document.querySelector('#verification-context').textContent = [
    `校验来源：${verificationConfiguration.source}。`,
    '生成器中有尚未生成的修改，当前仍验证最近一次完整配置。'
  ].join('');
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
  const entryAccess = project.entryAccess === undefined
    ? { mode: 'disabled' }
    : project.entryAccess;
  if (!entryAccess || Array.isArray(entryAccess) || typeof entryAccess !== 'object') {
    throw new Error('entryAccess 必须是对象。');
  }
  if (!['disabled', 'required'].includes(entryAccess.mode)) {
    throw new Error('entryAccess.mode 必须是 disabled 或 required。');
  }
  if (entryAccess.mode === 'required') {
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(entryAccess.entryAlias)) {
      throw new Error('entryAccess.entryAlias 必须是有效 Alias。');
    }
    const entryTtlSeconds = entryAccess.ttlSeconds === undefined ? 1800 : entryAccess.ttlSeconds;
    if (!Number.isInteger(entryTtlSeconds) || entryTtlSeconds < 300 || entryTtlSeconds > 86400) {
      throw new Error('entryAccess.ttlSeconds 必须是 300–86400 之间的整数。');
    }
  }
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

function validateEntryAccessRelationships(projects) {
  for (const [alias, project] of Object.entries(projects)) {
    const entryAccess = project.entryAccess === undefined
      ? { mode: 'disabled' }
      : project.entryAccess;
    if (entryAccess.mode !== 'required') continue;

    const entryProject = projects[entryAccess.entryAlias];
    if (!entryProject || entryAccess.entryAlias === alias) {
      throw new Error(`应用“${alias}”的统一入口 Alias 必须引用另一个已配置应用。`);
    }
    if (project.deliveryMode !== 'proxy' || entryProject.deliveryMode !== 'proxy') {
      throw new Error(`应用“${alias}”及其统一入口“${entryAccess.entryAlias}”都必须使用反向代理。`);
    }
    if (entryProject.edgeAccess?.mode !== 'required') {
      throw new Error(`统一入口“${entryAccess.entryAlias}”必须启用 Gateway 密码登录。`);
    }
    if ((entryProject.entryAccess?.mode || 'disabled') !== 'disabled') {
      throw new Error(`统一入口“${entryAccess.entryAlias}”不能再依赖其他统一入口。`);
    }
  }
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
