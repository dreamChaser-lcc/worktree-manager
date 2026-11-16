import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * CodeBuddy CLI 解析：定位可执行文件 + 读取本机网关密码。
 * 与 herdr 的解析思路一致（配置 → PATH → 自管安装目录），
 * 但 CodeBuddy 通过 npm/pnpm 全局安装，PATH 上通常是 .CMD 包装脚本。
 */

/** 在 PATH 上定位命令（Windows 用 where.exe，其他平台用 which）；未命中时静默返回 null */
function locateOnPath(commandText) {
  try {
    const locateResult = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [commandText], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      // 未命中时 where.exe 会把提示写到 stderr，这里吞掉避免污染服务日志
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const candidateList = locateResult
      .split(/\r?\n/)
      .map((lineText) => lineText.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    if (candidateList.length === 0) {
      return null;
    }
    // Windows 下 where 可能同时返回 .CMD 与（无扩展名的）POSIX 脚本，优先取 cmd 包装器
    if (process.platform === 'win32') {
      const cmdCandidate = candidateList.find((candidatePath) => /\.cmd$/i.test(candidatePath));
      return cmdCandidate || candidateList[0];
    }
    return candidateList[0];
  } catch {
    return null;
  }
}

/** 解析 codebuddy 可执行文件绝对路径；未安装时返回 null */
export function resolveCodebuddyExecutable() {
  return locateOnPath('codebuddy') || locateOnPath('cbc');
}

/** 本机 CodeBuddy 网关配置文件路径（网关密码存放在其中的 gateway.password） */
function resolveGatewaySettingsPath() {
  return path.join(os.homedir(), '.codebuddy', 'settings.json');
}

/**
 * 读取本机网关密码：--serve 默认 password 认证，密码由 CLI 首次启动生成并写入用户级配置。
 * 平台以 AP I 方式调用实例时必须带同一个密码，所以这里直接复用，避免多份凭据。
 */
export function readCodebuddyGatewayToken() {
  const settingsPath = resolveGatewaySettingsPath();
  let settingsText = '';
  try {
    settingsText = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return { token: null, settingsPath, reason: '未找到 ~/.codebuddy/settings.json' };
  }

  try {
    const settingsJson = JSON.parse(settingsText);
    const gatewaySection = settingsJson && settingsJson.gateway ? settingsJson.gateway : {};
    const tokenText = typeof gatewaySection.password === 'string' ? gatewaySection.password.trim() : '';
    if (!tokenText) {
      return { token: null, settingsPath, reason: 'settings.json 中缺少 gateway.password' };
    }
    return { token: tokenText, settingsPath, reason: null };
  } catch {
    return { token: null, settingsPath, reason: 'settings.json 不是合法 JSON' };
  }
}

/**
 * 读取 CLI 版本号（环境探测用，失败返回 null，不阻断功能）。
 * 用 execSync 而非 execFileSync + shell：后者执行 .CMD 时拿不到 stdout。
 */
export function readCodebuddyVersion(executablePath) {
  if (!executablePath) {
    return null;
  }
  try {
    const versionText = execSync(`"${executablePath}" --version`, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    return String(versionText).trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/** 环境摘要：CLI 是否可用、密码是否可读，供前端提示引导 */
export function describeCodebuddyEnvironment() {
  const executablePath = resolveCodebuddyExecutable();
  const tokenResult = readCodebuddyGatewayToken();
  return {
    executablePath,
    executableAvailable: Boolean(executablePath),
    settingsPath: tokenResult.settingsPath,
    tokenAvailable: Boolean(tokenResult.token),
    environmentIssue: !executablePath
      ? '未找到 codebuddy 命令，请先安装 CodeBuddy CLI（npm i -g @tencent-ai/codebuddy-code）'
      : tokenResult.reason,
    version: null
  };
}
