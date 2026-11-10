import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFileDir = path.dirname(fileURLToPath(import.meta.url));

/** 服务配置集中管理，避免散落魔法值 */
export const serverConfig = {
  /**
   * 监听地址：默认仅本机回环（局域网不可访问）。
   * 需要内网其他机器通过本机 IP 访问时，设置环境变量 WORKTREE_MANAGER_HOST=0.0.0.0
   * （start.bat 已默认设置；注意放开后本工具的目录浏览/编辑器能力将对内网暴露）。
   */
  host: process.env.WORKTREE_MANAGER_HOST || '127.0.0.1',
  port: Number(process.env.WORKTREE_MANAGER_PORT || 5210),
  /**
   * 前端生产构建产物目录，由 Koa 静态托管。
   * 桌面壳（Electron/Tauri）通过 WORKTREE_MANAGER_WEB_DIST 注入实际产物目录——
   * 编译/打包产物中 import.meta.url 相对推算会失效，与 WORKTREE_MANAGER_APP_DATA 同为最小兼容点。
   */
  webDistPath: process.env.WORKTREE_MANAGER_WEB_DIST || path.resolve(currentFileDir, '../../web/dist'),
  /** 程序根目录（server/src 向上两级），便携数据目录的锚点 */
  appRootPath: path.resolve(currentFileDir, '../..'),
  /**
   * 便携数据目录：<程序根>/data（数据目录模式 dataLocationMode = 'app-data' 时启用）。
   * 桌面壳（Electron）通过 WORKTREE_MANAGER_APP_DATA 注入安装目录下的 data（resources 只读时的可写位置），不设则用本默认值。
   */
  appDataDirectoryPath: process.env.WORKTREE_MANAGER_APP_DATA || path.resolve(currentFileDir, '../../data'),
  /** 默认编辑器启动命令，可被请求参数覆盖 */
  defaultEditorCommand: 'code',
  /**
   * herdr 可执行文件：留空表示自动探测（PATH → ~/.herdr/packages/standalone/releases 下最高版本）。
   * 安装在非标准位置时可填绝对路径。
   */
  herdrCommand: '',
  /** 忽略文件复制默认白名单 */
  defaultIgnoreFilePatterns: ['.env', '.env.local', '*.local'],
  /**
   * 忽略目录复制默认白名单：命中目录整棵递归复制到新 worktree，目标已存在时覆盖。
   * `.husky` 含 gitignore 的钩子运行时目录（v9 起为 `.husky/_`），worktree 不复制会导致提交钩子失效。
   */
  defaultIgnoreDirectoryNames: ['.husky'],
  /** git 命令默认超时（毫秒） */
  gitCommandTimeoutMs: 60_000
};
