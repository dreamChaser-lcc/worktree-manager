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
  /** 前端生产构建产物目录，由 Koa 静态托管 */
  webDistPath: path.resolve(currentFileDir, '../../web/dist'),
  /** 默认编辑器启动命令，可被请求参数覆盖 */
  defaultEditorCommand: 'code',
  /** 忽略文件复制默认白名单 */
  defaultIgnoreFilePatterns: ['.env', '.env.local', '*.local'],
  /** git 命令默认超时（毫秒） */
  gitCommandTimeoutMs: 60_000
};
