import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, '..', '..');
const forbiddenPaths = [
  '.github/dependabot.yml',
  '.github/dependabot.yaml'
];

function listWorkflowEntries(directory) {
  const stats = lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory()) return [directory];

  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = join(directory, entry.name);
    return entry.isDirectory() ? listWorkflowEntries(entryPath) : [entryPath];
  });
}

const workflowDirectory = join(repositoryRoot, '.github', 'workflows');
const violations = [
  ...listWorkflowEntries(workflowDirectory),
  ...forbiddenPaths
    .map(path => join(repositoryRoot, path))
    .filter(path => lstatSync(path, { throwIfNoEntry: false }))
];

if (violations.length > 0) {
  console.error('本仓库禁止托管 CI/CD 或自动依赖更新配置');
  for (const path of violations) {
    console.error(`- ${relative(repositoryRoot, path)}`);
  }
  process.exitCode = 1;
} else {
  console.log('Repository policy check passed: no hosted CI/CD or automatic dependency update configuration.');
}
