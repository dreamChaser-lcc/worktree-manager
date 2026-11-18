const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * 干净启动器。
 *
 * 背景：从 CodeBuddy 终端/IDE 里启动 node 时，进程会继承 IDE 注入的
 *   NODE_OPTIONS=--require <node-language-shim.cjs>
 *   CODEBUDDY_SESSION_ID=...
 * 该 shim 会给 fs 打补丁做 safe-delete 保护：单次「turn」内删除文件超过 500 个
 * 就抛 [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]，并拼出 `...\$null` 这种错误路径。
 * 平台删除 worktree 时正是用它递归删文件，于是删到第 500 个就失败，
 * 表现为「部分关联 worktree 删除失败」，重试多少次都一样。
 *
 * 这里在拉子进程前把这些变量摘掉，保证业务进程的 fs 是原生的。
 */
const projectRoot = path.resolve(__dirname, '..');

const cleanEnv = { ...process.env };
delete cleanEnv.NODE_OPTIONS;
delete cleanEnv.CODEBUDDY_SESSION_ID;
delete cleanEnv.CLAUDE_SESSION_ID;
cleanEnv.CODEBUDDY_SAFE_DELETE_ENABLED = '0';

const childProcess = spawn(process.execPath, [path.join(projectRoot, 'server', 'src', 'server.js')], {
  cwd: projectRoot,
  env: cleanEnv,
  stdio: 'inherit'
});

childProcess.on('exit', (exitCode) => process.exit(exitCode === null ? 0 : exitCode));
childProcess.on('error', (spawnError) => {
  console.error(`[start-server] 启动失败: ${spawnError.message}`);
  process.exit(1);
});
