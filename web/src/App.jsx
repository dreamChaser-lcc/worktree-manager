import React, { useEffect, useState } from 'react';
import { CreateWorktreeForm } from './components/CreateWorktreeForm.jsx';
import { WorktreeListPanel } from './components/WorktreeListPanel.jsx';
import { RequirementTaskPanel } from './components/RequirementTaskPanel.jsx';
import { TaskHistoryPanel } from './components/TaskHistoryPanel.jsx';
import { CreationHistoryPanel } from './components/CreationHistoryPanel.jsx';
import { SettingsPanel } from './components/SettingsPanel.jsx';
import { HelpGuideDialog } from './components/HelpGuideDialog.jsx';
import { fetchRecentRepositories, fetchSettings } from './api/client.js';

/** 应用外壳：顶部标题 + 页签（需求任务 / 任务记录 / 创建 / 管理 / 设置），主仓库目录全局共享 */
export function App() {
  const [activeTab, setActiveTab] = useState('requirements');
  const [serverReady, setServerReady] = useState(false);
  // 主仓库目录提升至应用层：创建页/管理页共享，最近主仓库切换对两页同时生效
  const [repoPath, setRepoPath] = useState('');
  const [recentRepoList, setRecentRepoList] = useState([]);
  // 项目存放目录：目录选择器的默认起始定位，设置页可改
  const [projectDirectory, setProjectDirectory] = useState('');
  // 工作区文件目录与需求聚合目录模式（worktree 代码与工作区文件同目录）
  const [workspaceDirectory, setWorkspaceDirectory] = useState('');
  const [workspaceLayoutEnabled, setWorkspaceLayoutEnabled] = useState(true);
  // 使用指南弹窗开关：入口在页头右上角
  const [helpDialogVisible, setHelpDialogVisible] = useState(false);

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then((data) => setServerReady(Boolean(data.ok)))
      .catch(() => setServerReady(false));
  }, []);

  useEffect(() => {
    fetchSettings()
      .then((settingsData) => {
        setProjectDirectory(settingsData.projectDirectory || '');
        setWorkspaceDirectory(settingsData.workspaceDirectory || '');
        setWorkspaceLayoutEnabled(settingsData.workspaceLayoutEnabled !== false);
      })
      .catch(() => {});
  }, []);

  // 启动时拉取最近主仓库（服务端持久化记录），自动回填最后使用项
  useEffect(() => {
    fetchRecentRepositories()
      .then((recentData) => {
        setRecentRepoList(recentData.repositories || []);
        if (recentData.lastUsedPath) {
          setRepoPath((currentPath) => currentPath || recentData.lastUsedPath);
        }
      })
      .catch(() => setRecentRepoList([]));
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-title">Worktree 管理器</h1>
        <span className={serverReady ? 'server-badge server-badge-online' : 'server-badge server-badge-offline'}>
          {serverReady ? '服务已连接' : '服务未连接'}
        </span>
        <button
          type="button"
          className="button-secondary help-entry-button"
          onClick={() => setHelpDialogVisible(true)}
        >
          使用指南
        </button>
      </header>
      <nav className="app-tabs">
        <button
          type="button"
          className={activeTab === 'requirements' ? 'tab-button tab-button-active' : 'tab-button'}
          onClick={() => setActiveTab('requirements')}
        >
          需求任务
        </button>
        <button
          type="button"
          className={activeTab === 'task-records' ? 'tab-button tab-button-active' : 'tab-button'}
          onClick={() => setActiveTab('task-records')}
        >
          任务记录
        </button>
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
        <button
          type="button"
          className={activeTab === 'settings' ? 'tab-button tab-button-active' : 'tab-button'}
          onClick={() => setActiveTab('settings')}
        >
          设置
        </button>
      </nav>
      <main className="app-main">
        {activeTab === 'create' ? (
          <CreateWorktreeForm
            repoPath={repoPath}
            onRepoPathChange={setRepoPath}
            recentRepoList={recentRepoList}
            initialBrowsePath={projectDirectory}
            workspaceDirectory={workspaceDirectory}
            workspaceLayoutEnabled={workspaceLayoutEnabled}
          />
        ) : null}
        {activeTab === 'manage' ? (
          <div>
            <WorktreeListPanel
              repoPath={repoPath}
              onRepoPathChange={setRepoPath}
              recentRepoList={recentRepoList}
              initialBrowsePath={projectDirectory}
            />
            <CreationHistoryPanel />
          </div>
        ) : null}
        {activeTab === 'requirements' ? (
          <RequirementTaskPanel
            initialBrowsePath={projectDirectory}
            workspaceDirectory={workspaceDirectory}
            workspaceLayoutEnabled={workspaceLayoutEnabled}
          />
        ) : null}
        {activeTab === 'settings' ? (
          <SettingsPanel
            onProjectDirectoryChange={setProjectDirectory}
            onWorkspaceLayoutChange={setWorkspaceLayoutEnabled}
          />
        ) : null}
        {activeTab === 'task-records' ? <TaskHistoryPanel /> : null}
      </main>
      {helpDialogVisible ? <HelpGuideDialog onClose={() => setHelpDialogVisible(false)} /> : null}
    </div>
  );
}
