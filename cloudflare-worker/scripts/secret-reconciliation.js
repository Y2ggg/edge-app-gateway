const BINDING_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export class SecretReconciliationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretReconciliationError';
  }
}

export function parseRemoteSecretNames(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new SecretReconciliationError('无法解析 Cloudflare 返回的 Secret 清单。');
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some(item => (
      !item ||
      Array.isArray(item) ||
      typeof item !== 'object' ||
      typeof item.name !== 'string' ||
      !BINDING_NAME_PATTERN.test(item.name)
    ))
  ) {
    throw new SecretReconciliationError('Cloudflare 返回了无效的 Secret 清单。');
  }

  return [...new Set(parsed.map(item => item.name))].sort();
}

export function compareSecretNames(remoteNames, desiredNames) {
  const remote = new Set(remoteNames);
  const desired = new Set(desiredNames);
  return {
    missing: [...desired].filter(name => !remote.has(name)).sort(),
    stale: [...remote].filter(name => !desired.has(name)).sort()
  };
}

export async function reconcileRemoteSecrets({ desiredSecretNames, runCommand, workerName }) {
  const currentNames = await listRemoteSecretNames(runCommand, workerName);
  const initialDifference = compareSecretNames(currentNames, desiredSecretNames);

  if (initialDifference.missing.length) {
    throw new SecretReconciliationError(
      `新版本部署后仍缺少 Secret Binding：${initialDifference.missing.join(', ')}。`
    );
  }

  if (!initialDifference.stale.length) return { deleted: [] };

  const deletionPayload = Object.fromEntries(
    initialDifference.stale.map(name => [name, null])
  );
  const deletionResult = await runCommand(
    ['secret', 'bulk', '--name', workerName],
    JSON.stringify(deletionPayload)
  );
  if (deletionResult.exitCode !== 0) {
    throw new SecretReconciliationError('删除残留 Secret 时 Cloudflare API 返回失败。');
  }

  const verifiedNames = await listRemoteSecretNames(runCommand, workerName);
  const verifiedDifference = compareSecretNames(verifiedNames, desiredSecretNames);
  if (verifiedDifference.missing.length || verifiedDifference.stale.length) {
    throw new SecretReconciliationError('删除后远端 Secret 清单仍与变量文件不一致。');
  }

  return { deleted: initialDifference.stale };
}

async function listRemoteSecretNames(runCommand, workerName) {
  const result = await runCommand(['secret', 'list', '--name', workerName]);
  if (result.exitCode !== 0) {
    throw new SecretReconciliationError('读取远端 Secret 清单时 Cloudflare API 返回失败。');
  }
  return parseRemoteSecretNames(result.stdout);
}
