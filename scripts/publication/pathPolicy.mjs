const environmentTemplate = /(?:^|\/)\.env(?:\.[^/]+)?\.(?:example|sample|template)$/i;
const localFile = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?|password\.hash|db-password)$|\.(?:env|key|pem|crt|cer|der|p12|pfx|jks|keystore)$/i;
const privateDeployment = /(?:^|\/)(?:compose\.(?:server|override|[^/]+\.local)\.ya?ml$|deployment-config(?:\/|$))/i;
const privateConfig = /(?:^|\/)(?:\.aws|\.ssh|\.npmrc)(?:\/|$)/i;
const editorPath = /(?:^|\/)(\.vscode(?:\/.*)?$)/i;
const portableEditorFile = /^\.vscode\/(?:settings|extensions|launch|tasks)\.json$/i;
const generatedPath = /(?:^|\/)(?:\.git|node_modules|build|dist(?:-electron)?|output|out|release(?:-next)?|logs|coverage|generated|test-results|playwright-report|\.worktrees|\.idea|\.nyc_output|\.cache|\.npm|\.pnpm-store|\.electron-cache|\.electron-builder-cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|\.codex|\.agents|\.claude|\.superpowers|\.codebase-memory)(?:\/|$)/i;
const runtimePath = /^(?:(?:data|indexes|state|runtime|private|backups|files|attachments|tmp|temp)\/|docs\/(?:superpowers|plans)\/)/i;
const generatedFile = /\.(?:log|pid(?:\.lock)?|dump|sqlite3?|db|bak|tmp|temp|next|zip|7z|rar|tgz|tar(?:\.gz)?|sql\.gz|exe|msi|dmg|appimage|blockmap|tsbuildinfo|lcov)$|(?:^|\/)(?:\.eslintcache|\.stylelintcache|\.node_repl_history|\.DS_Store|Thumbs\.db|Desktop\.ini)$/i;
const planningDocument = /^docs\/(?:.*\/)?[^/]*-plans?\.md$/i;

export function isPlanningDocument(filename) {
  return planningDocument.test(filename.replaceAll('\\', '/'));
}

export function pathFinding(filename, { exporting = false } = {}) {
  const portableName = filename.replaceAll('\\', '/');
  const editor = editorPath.exec(portableName);
  if (privateDeployment.test(portableName)) return 'private deployment configuration';
  if (privateConfig.test(portableName)) return 'private access or package configuration';
  if (editor && !portableEditorFile.test(editor[1])) return 'local editor session or state';
  if (generatedPath.test(portableName) || runtimePath.test(portableName)) return 'tracked local output, dependency or assistant state';
  if (localFile.test(portableName) && !environmentTemplate.test(portableName)) return 'local certificate or key / environment file';
  if (generatedFile.test(portableName)) return 'generated diagnostic, database, backup or distribution artifact';
  // Source export intentionally omits these notes; Git publication must reject them.
  if (!exporting && isPlanningDocument(portableName)) return 'local implementation planning document';
  return undefined;
}
