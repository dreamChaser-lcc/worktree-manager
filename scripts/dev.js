import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * 开发启动器：在当前终端同时运行
 * 1. 后端热重启（node --watch server/src/server.js）
 * 2. 前端自动打包（vite build --watch，dist 重建后刷新浏览器即生效）
 * 输出带 [server]/[web] 前缀区分；Ctrl+C 一并退出两个进程。
 */

const CHILD_PROCESS_LIST = [
  {
    name: 'server',
    colorCode: '\x1b[35m',
    commandText: 'node',
    argumentList: ['--watch', 'server/src/server.js']
  },
  {
    name: 'web',
    colorCode: '\x1b[36m',
    commandText: 'npm',
    argumentList: ['--prefix', 'web', 'run', 'build', '--', '--watch']
  }
];

let isShuttingDown = false;
const childProcessList = [];

function printChildOutput(childName, colorCode, dataBuffer) {
  const prefixText = `[${childName}] ${colorCode}`;
  String(dataBuffer)
    .split(/\r?\n/)
    .filter((lineText) => lineText.trim() !== '')
    .forEach((lineText) => {
      console.log(`${prefixText}${lineText}\x1b[0m`);
    });
}

function killChildProcessTree(childProcess) {
  if (process.platform === 'win32' && childProcess.pid) {
    // Windows 下 shell 包装的进程需要按进程树终止，避免孤儿进程
    spawn('taskkill', ['/pid', String(childProcess.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  childProcess.kill('SIGTERM');
}

function shutdownAll() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log('\n[dev] 正在停止全部开发进程...');
  childProcessList.forEach(killChildProcessTree);
  process.exit(0);
}

for (const childOption of CHILD_PROCESS_LIST) {
  const childProcess = spawn(childOption.commandText, childOption.argumentList, {
    shell: process.platform === 'win32',
    env: process.env
  });
  childProcessList.push(childProcess);

  childProcess.stdout.on('data', (dataBuffer) =>
    printChildOutput(childOption.name, childOption.colorCode, dataBuffer)
  );
  childProcess.stderr.on('data', (dataBuffer) =>
    printChildOutput(childOption.name, childOption.colorCode, dataBuffer)
  );
  childProcess.on('exit', (exitCode) => {
    if (!isShuttingDown) {
      console.log(`[dev] [${childOption.name}] 进程退出（code ${exitCode}）`);
    }
  });
}

console.log('[dev] 已启动：server(node --watch) + web(vite build --watch)，Ctrl+C 全部退出');
process.on('SIGINT', shutdownAll);
process.on('SIGTERM', shutdownAll);
