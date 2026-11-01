const { contextBridge, ipcRenderer } = require('electron');

/**
 * 预加载：向页面（web/dist，经 http://127.0.0.1 加载）暴露最小桌面桥。
 * 浏览器访问时 window.desktopBridge 不存在，前端据此后备为纯 Web 行为。
 */
contextBridge.exposeInMainWorld('desktopBridge', {
  isDesktop: true,
  /** 系统原生通知：点击聚焦应用主窗口 */
  notify: (title, body) => ipcRenderer.send('desktop-notify', { title, body })
});
