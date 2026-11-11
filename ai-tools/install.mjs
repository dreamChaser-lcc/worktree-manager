#!/usr/bin/env node
/**
 * ai-tools 安装脚本：部署 skill，并输出 MCP 注册配置。
 *
 * 用法（在仓库根目录执行）：
 *   node ai-tools/install.mjs                     装到当前项目（.codebuddy/skills）
 *   node ai-tools/install.mjs --global            装到用户目录（所有项目可用）
 *   node ai-tools/install.mjs --install-deps      额外执行 mcp-server 的 npm install
 *   node ai-tools/install.mjs --print-only        只打印配置，不改磁盘
 *
 * 全局安装会额外把 mcp-server 复制到 ~/.codebuddy/mcp-servers/worktree-manager/，
 * 与仓库解耦：仓库移动或删除都不影响已装的工具；升级时重跑本脚本覆盖即可。
 *
 * 换电脑后的完整流程见 ai-tools/README.md。
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const aiToolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRootDirectory = path.resolve(aiToolsDirectory, '..');
const skillSourceDirectory = path.join(aiToolsDirectory, 'skill', 'worktree-manager');
const mcpSourceDirectory = path.join(aiToolsDirectory, 'mcp-server');

const argumentList = process.argv.slice(2);
const flagSet = new Set(argumentList.filter((argumentItem) => argumentItem.startsWith('--')));

const printOnly = flagSet.has('--print-only');
const installDeps = flagSet.has('--install-deps');
const globalInstall = flagSet.has('--global');

const userCodeBuddyDirectory = path.join(os.homedir(), '.codebuddy');

/** skill 部署目标：项目级 .codebuddy/skills 或用户级 ~/.codebuddy/skills */
const skillTargetDirectory = globalInstall
  ? path.join(userCodeBuddyDirectory, 'skills', 'worktree-manager')
  : path.join(projectRootDirectory, '.codebuddy', 'skills', 'worktree-manager');

/** MCP 运行位置：全局安装时复制到用户目录，与仓库解耦 */
const mcpRuntimeDirectory = globalInstall
  ? path.join(userCodeBuddyDirectory, 'mcp-servers', 'worktree-manager')
  : mcpSourceDirectory;

const mcpEntryPath = path.join(mcpRuntimeDirectory, 'index.js');

function printHeader(titleText) {
  console.log(`\n=== ${titleText} ===`);
}

/** 1. 部署 skill：整体覆盖，避免残留旧文件 */
function deploySkill() {
  printHeader('部署 skill');
  if (!existsSync(skillSourceDirectory)) {
    console.error(`✗ 找不到 skill 源目录：${skillSourceDirectory}`);
    process.exitCode = 1;
    return;
  }
  if (printOnly) {
    console.log(`[dry-run] 将复制 ${skillSourceDirectory}`);
    console.log(`       →  ${skillTargetDirectory}`);
    return;
  }
  rmSync(skillTargetDirectory, { recursive: true, force: true });
  mkdirSync(path.dirname(skillTargetDirectory), { recursive: true });
  cpSync(skillSourceDirectory, skillTargetDirectory, { recursive: true });
  console.log(`✓ 已部署到 ${skillTargetDirectory}`);
  console.log(
    globalInstall
      ? '  所有项目都能识别这个 skill，无需在每个仓库里重复部署。'
      : '  重启 CodeBuddy（或重开项目）后，skill 会在本项目中自动加载。'
  );
}

/** 2. 全局安装时把 mcp-server 复制到用户目录，脱离仓库路径 */
function deployMcpServer() {
  if (!globalInstall) {
    return;
  }
  printHeader('复制 MCP server 到用户目录');
  if (printOnly) {
    console.log(`[dry-run] 将复制 ${mcpSourceDirectory}`);
    console.log(`       →  ${mcpRuntimeDirectory}`);
    return;
  }
  // 只覆盖源码，保留已有的 node_modules，避免每次都要重装依赖
  mkdirSync(mcpRuntimeDirectory, { recursive: true });
  cpSync(path.join(mcpSourceDirectory, 'index.js'), path.join(mcpRuntimeDirectory, 'index.js'));
  cpSync(path.join(mcpSourceDirectory, 'package.json'), path.join(mcpRuntimeDirectory, 'package.json'));
  console.log(`✓ 已部署到 ${mcpRuntimeDirectory}`);
  console.log('  该副本独立于仓库：仓库移动或删除都不影响已装的 MCP。');
}

/** 3. 打印 MCP 注册片段：路径按安装位置生成，直接粘进 mcp.json */
function printMcpConfig() {
  printHeader('MCP 注册配置');
  const configEntry = {
    command: 'node',
    args: [mcpEntryPath],
    env: { WORKTREE_MANAGER_API: 'http://127.0.0.1:5210' },
    type: 'stdio',
    timeout: 60000,
    disabled: false
  };
  const configFilePath =
    process.platform === 'win32'
      ? '%USERPROFILE%\\.codebuddy\\mcp.json'
      : '~/.codebuddy/mcp.json';
  console.log(`把下面这段加到 ${configFilePath} 的 mcpServers 里：\n`);
  console.log(`"worktree-manager": ${JSON.stringify(configEntry, null, 2)}`);
  console.log(
    globalInstall
      ? '\n该配置指向用户目录下的副本，注册一次对所有项目生效。配置本身是全局文件，添加前请先备份。'
      : '\n注意：mcp.json 是全局配置（所有项目共享），但这里的 args 指向本仓库路径，仓库移动后需要改这一行；想彻底解耦请用 --global。'
  );
}

/** 4. 可选：安装 MCP server 依赖 */
function installMcpDependencies() {
  printHeader('安装 MCP 依赖');
  if (printOnly) {
    console.log(`[dry-run] 将在 ${mcpRuntimeDirectory} 执行 npm install`);
    return;
  }
  if (!installDeps) {
    console.log('跳过（如需自动安装，追加 --install-deps；或手动执行）：');
    console.log(`  cd "${mcpRuntimeDirectory}" && npm install`);
    return;
  }
  if (!existsSync(path.join(mcpRuntimeDirectory, 'package.json'))) {
    console.error(`✗ 目标目录缺少 package.json：${mcpRuntimeDirectory}`);
    process.exitCode = 1;
    return;
  }
  const installResult = spawnSync('npm', ['install'], {
    cwd: mcpRuntimeDirectory,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (installResult.status === 0) {
    console.log('✓ 依赖安装完成');
  } else {
    console.error('✗ 依赖安装失败，请手动进入该目录执行 npm install');
    process.exitCode = 1;
  }
}

function main() {
  console.log('worktree-manager AI 工具安装');
  console.log(`安装模式：${globalInstall ? '全局（用户目录，所有项目可用）' : '项目级（仅当前仓库）'}`);
  console.log(`仓库根目录：${projectRootDirectory}`);

  deploySkill();
  deployMcpServer();
  printMcpConfig();
  installMcpDependencies();

  printHeader('下一步');
  if (process.exitCode) {
    console.log('存在失败项，请按上面的提示处理后重跑。');
    return;
  }
  console.log('1. 确认平台已启动（项目根目录 start.bat）');
  console.log('2. 编辑 mcp.json 加入上面的片段（如已存在同名项则替换）');
  console.log('3. 重启 CodeBuddy，在 MCP 面板确认 worktree-manager 已连接');
  console.log('4. 新会话里问「列出最近的需求任务」验证工具可用');
}

main();
