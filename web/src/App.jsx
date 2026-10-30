import React, { useEffect, useState } from 'react';
import { CreateWorktreeForm } from './components/CreateWorktreeForm.jsx';
import { WorktreeListPanel } from './components/WorktreeListPanel.jsx';

/** 应用外壳：顶部标题 + 两个页签（创建 / 管理） */
export function App() {
  const [activeTab, setActiveTab] = useState('create');
  const [serverReady, setServerReady] = useState(false);

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then((data) => setServerReady(Boolean(data.ok)))
      .catch(() => setServerReady(false));
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-title">Worktree 管理器</h1>
        <span className={serverReady ? 'server-badge server-badge-online' : 'server-badge server-badge-offline'}>
          {serverReady ? '服务已连接' : '服务未连接'}
        </span>
      </header>
      <nav className="app-tabs">
        <button
          type="button"
          className={activeTab === 'create' ? 'tab-button tab-button-active' : 'tab-button'}
          onClick={() => setActiveTab('create')}
        >
          创建 Worktree
        </button>
        <button
          type="button"
          className={activeTab === 'manage' ? 'tab-button tab-button-active' : 'tab-button'}
          onClick={() => setActiveTab('manage')}
        >
          Worktree 管理
        </button>
      </nav>
      <main className="app-main">
        {activeTab === 'create' ? <CreateWorktreeForm /> : <WorktreeListPanel />}
      </main>
    </div>
  );
}
