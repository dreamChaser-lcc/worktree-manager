import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * settings.json 读写（固定位于用户目录 %USERPROFILE%\.worktree-manager\）。
 * 原子写：先写临时文件再 rename，避免半截文件。
 * 读取：缺失或损坏均返回 null，由调用方按默认规则重建，不影响数据目录中的业务数据。
 */
export async function readSettingsFile(settingsFilePath) {
  let rawText = null;
  try {
    rawText = await fs.readFile(settingsFilePath, 'utf8');
  } catch {
    return null; // 不存在视为未配置
  }
  try {
    const parsedSettings = JSON.parse(rawText);
    if (parsedSettings && typeof parsedSettings === 'object' && !Array.isArray(parsedSettings)) {
      return parsedSettings;
    }
    return null; // 结构非法视为损坏
  } catch {
    return null; // JSON 损坏视为损坏
  }
}

export async function writeSettingsFile(settingsFilePath, settingsObject) {
  await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
  const temporaryFilePath = `${settingsFilePath}.tmp`;
  await fs.writeFile(temporaryFilePath, JSON.stringify(settingsObject, null, 2), 'utf8');
  await fs.rename(temporaryFilePath, settingsFilePath);
}
