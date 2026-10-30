import fs from 'node:fs';
import path from 'node:path';

/** 默认数据根目录（用户指定：D 盘 softwares 目录下） */
export const DEFAULT_DATA_ROOT_PATH = 'D:\\softwares\\worktree-manager';

/** 盘符缺失时的回退目录名（置于用户主目录下） */
export const FALLBACK_DATA_DIRECTORY_NAME = 'worktree-manager-data';

/** 代码默认存储目录（目录选择器的起始定位，用户指定：D 盘 project 目录） */
export const DEFAULT_PROJECT_DIRECTORY_PATH = 'D:\\project';

/**
 * 解析数据根目录候选列表（按优先级降序）：
 * 1. 配置值（settings.json 的 dataDirectory，需为绝对路径）
 * 2. 默认值（默认盘符存在时，即 D:\softwares\worktree-manager）
 * 3. 用户目录回退（%USERPROFILE%\worktree-manager-data，仅默认盘符缺失时提供）
 *
 * directoryExists 可注入以便单测模拟盘符缺失；调用方按序尝试创建目录，
 * 第一个创建成功的候选生效，配置候选失败时降级到默认链并告警。
 */
export function resolveDataRootCandidates({
  settingsDataDirectory,
  homeDirectoryPath,
  defaultDataRootPath = DEFAULT_DATA_ROOT_PATH,
  directoryExists = (candidatePath) => fs.existsSync(candidatePath)
}) {
  const candidateList = [];

  if (settingsDataDirectory && typeof settingsDataDirectory === 'string' && path.isAbsolute(settingsDataDirectory)) {
    candidateList.push({ source: 'settings', dataRootPath: path.resolve(settingsDataDirectory) });
  }

  const defaultParentPath = path.dirname(defaultDataRootPath);
  const defaultDriveAvailable = directoryExists(defaultParentPath) || directoryExists(defaultDataRootPath);
  candidateList.push({ source: 'default', dataRootPath: path.resolve(defaultDataRootPath), available: defaultDriveAvailable });

  if (!defaultDriveAvailable) {
    candidateList.push({
      source: 'fallback',
      dataRootPath: path.join(homeDirectoryPath, FALLBACK_DATA_DIRECTORY_NAME)
    });
  }

  return candidateList;
}
