import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFileDir = path.dirname(fileURLToPath(import.meta.url));

/** 服务配置集中管理，避免散落魔法值 */
export const serverConfig = {
  /** 仅监听本机回环地址，拒绝局域网访问 */
  host: '127.0.0.1',
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
