const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

/**
 * Electron 桌面壳：主进程即 Node，dynamic import 现有 Koa 服务（零架构改造），
 * 加载 web/dist 页面；提供单实例锁、托盘、原生通知、开机自启、窗口记忆与便携数据目录。
 * 打包后目录结构（extraResources）：
 *   resources/server/        server 源码 + node_modules（Koa/nedb 等运行时依赖）
 *   resources/web-dist/      前端构建产物
 *   resources/app.asar       本目录（main.js / preload.js / assets）
 */

const isPackaged = app.isPackaged;
// 资源根：开发态 = 仓库根（desktop-electron/..）；打包态 = resources 目录
const projectRoot = isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const serverEntryPath = path.join(projectRoot, 'server', 'src', 'server.js');
const webDistIndexPath = isPackaged
  ? path.join(process.resourcesPath, 'web-dist', 'index.html')
  : path.join(projectRoot, 'web', 'dist', 'index.html');
const trayIconPath = path.join(__dirname, 'assets', 'tray.png');
const windowStateFilePath = path.join(app.getPath('userData'), 'desktop-window-state.json');

// ⚠️ 便携数据目录：指向安装目录（per-user 安装默认可写）下的 data；开发态为仓库 data/。
// 通过环境变量注入（config.js 支持覆盖），server 侧零改造。
const portableDataDirectoryPath = isPackaged
  ? path.join(path.dirname(app.getPath('exe')), 'data')
  : path.join(projectRoot, 'data');
// ⚠️ 前端静态产物目录：打包态为 resources/web-dist（与 config.js 相对推算结果不同，必须注入）；开发态走默认解析。
const webDistDirectoryOverride = isPackaged
  ? path.join(process.resourcesPath, 'web-dist')
  : null;

let mainWindow = null;
let tray = null;
let serverPort = null;
// 关闭行为：true = 最小化到托盘（会话内生效，托盘菜单可切换；持久化在二期设置页接入）
let minimizeToTrayEnabled = true;

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(windowStateFilePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) {
    return;
  }
  const bounds = mainWindow.getBounds();
  const state = { ...bounds, maximized: mainWindow.isMaximized() };
  try {
    fs.writeFileSync(windowStateFilePath, JSON.stringify(state));
  } catch {
    // 记忆失败不影响使用
  }
}

function createMainWindow() {
  const savedState = readWindowState();
  mainWindow = new BrowserWindow({
    width: savedState.width || 1280,
    height: savedState.height || 800,
    x: savedState.x,
    y: savedState.y,
    title: 'Worktree 管理器',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (savedState.maximized) {
    mainWindow.maximize();
  }
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (closeEvent) => {
    saveWindowState();
    if (minimizeToTrayEnabled && tray) {
      closeEvent.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const trayImage = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(trayImage.isEmpty() ? nativeImage.createEmpty() : trayImage);
  tray.setToolTip(`Worktree 管理器（http://127.0.0.1:${serverPort}）`);

  const contextMenu = Menu.buildFromTemplate([
    { label: '打开主界面', click: showMainWindow },
    { type: 'separator' },
    {
      label: '关闭时最小化到托盘',
      type: 'checkbox',
      checked: minimizeToTrayEnabled,
      click: (menuItem) => {
        minimizeToTrayEnabled = menuItem.checked;
      }
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        // 打包安装后生效（开发态 path 指向 electron.exe，无实际意义）
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', showMainWindow);
}

/** 探测端口是否可绑定；port 传 0 时返回系统分配的随机端口 */
function probeFreePort(preferredPort) {
  return new Promise((resolve) => {
    const probeServer = net.createServer();
    probeServer.once('error', () => resolve(null));
    probeServer.once('listening', () => {
      const actualPort = probeServer.address().port;
      probeServer.close(() => resolve(actualPort));
    });
    probeServer.listen(preferredPort, '127.0.0.1');
  });
}

async function waitForServerHealthy(port, attemptLimit = 30) {
  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // 未就绪继续等待
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
  return false;
}

/** 内嵌启动现有 Koa 服务：端口被占用时自动换端口；数据目录走便携模式 */
async function startEmbeddedServer() {
  const preferredPort = await probeFreePort(5210);
  serverPort = preferredPort ?? (await probeFreePort(0));
  if (preferredPort === null) {
    console.log(`[desktop] 端口 5210 被占用，已自动换用端口 ${serverPort}`);
  }

  process.env.WORKTREE_MANAGER_PORT = String(serverPort);
  process.env.WORKTREE_MANAGER_HOST = '127.0.0.1';
  process.env.WORKTREE_MANAGER_APP_DATA = portableDataDirectoryPath;
  if (webDistDirectoryOverride) {
    process.env.WORKTREE_MANAGER_WEB_DIST = webDistDirectoryOverride;
  }

  await import(require('node:url').pathToFileURL(serverEntryPath).href);
  const healthy = await waitForServerHealthy(serverPort);
  if (!healthy) {
    throw new Error('内嵌服务健康检查超时');
  }
  console.log(`[desktop] 内嵌服务就绪: http://127.0.0.1:${serverPort}`);
  return serverPort;
}

// 单实例锁：重复启动时激活已有窗口，规避 nedb 无跨进程锁风险
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(async () => {
    ipcMain.on('desktop-notify', (_ipcEvent, payload) => {
      if (!Notification.isSupported() || !payload) {
        return;
      }
      const notification = new Notification({
        title: String(payload.title || 'Worktree 管理器'),
        body: String(payload.body || ''),
        icon: path.join(__dirname, 'build', 'icon.png')
      });
      notification.on('click', showMainWindow);
      notification.show();
    });

    try {
      await startEmbeddedServer();
    } catch (startError) {
      dialog.showErrorBox('Worktree 管理器启动失败', String(startError.message || startError));
      app.quit();
      return;
    }

    createTray();
    showMainWindow();
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：不主动退出，由托盘菜单「退出」触发
  });
}
