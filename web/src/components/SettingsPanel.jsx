import React, { useEffect, useState } from 'react';
import { fetchSettings, updateSettings, fetchInstalledEditors } from '../api/client.js';

/**
 * 设置面板：数据根目录（任务/历史/日志存储位置）与项目存放目录（目录选择器默认定位）。
 * 两个设置相互独立、各自保存；数据目录修改立即生效且不迁移历史数据。
 */
export function SettingsPanel({ onProjectDirectoryChange, onWorkspaceLayoutChange }) {
  const [currentDataDirectory, setCurrentDataDirectory] = useState('');
  const [inputDataDirectory, setInputDataDirectory] = useState('');
  const [currentProjectDirectory, setCurrentProjectDirectory] = useState('');
  const [inputProjectDirectory, setInputProjectDirectory] = useState('');
  const [currentWorkspaceDirectory, setCurrentWorkspaceDirectory] = useState('');
  const [inputWorkspaceDirectory, setInputWorkspaceDirectory] = useState('');
  const [workspaceLayoutEnabled, setWorkspaceLayoutEnabled] = useState(true);
  const [currentEditorCommand, setCurrentEditorCommand] = useState('');
  const [inputEditorCommand, setInputEditorCommand] = useState('');
  const [editorOptionList, setEditorOptionList] = useState([]);
  const [dataSaveState, setDataSaveState] = useState(null);
  const [projectSaveState, setProjectSaveState] = useState(null);
  const [workspaceSaveState, setWorkspaceSaveState] = useState(null);
  const [editorSaveState, setEditorSaveState] = useState(null);
  const [savingData, setSavingData] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [savingEditor, setSavingEditor] = useState(false);

  useEffect(() => {
    fetchSettings()
      .then((settingsData) => {
        setCurrentDataDirectory(settingsData.dataDirectory || '');
        setInputDataDirectory(settingsData.dataDirectory || '');
        setCurrentProjectDirectory(settingsData.projectDirectory || '');
        setInputProjectDirectory(settingsData.projectDirectory || '');
        setCurrentWorkspaceDirectory(settingsData.workspaceDirectory || '');
        setInputWorkspaceDirectory(settingsData.workspaceDirectory || '');
        setWorkspaceLayoutEnabled(settingsData.workspaceLayoutEnabled !== false);
        setCurrentEditorCommand(settingsData.editorCommand || '');
        setInputEditorCommand(settingsData.editorCommand || '');
      })
      .catch((loadError) => {
        setDataSaveState({ type: 'error', text: `读取设置失败: ${loadError.message}` });
      });
  }, []);

  useEffect(() => {
    fetchInstalledEditors()
      .then((detectData) => setEditorOptionList(detectData.editors || []))
      .catch(() => setEditorOptionList([]));
  }, []);

  async function handleSaveDataDirectory() {
    setSavingData(true);
    setDataSaveState(null);
    try {
      const savedSettings = await updateSettings({ dataDirectory: inputDataDirectory.trim() });
      setCurrentDataDirectory(savedSettings.dataDirectory);
      setInputDataDirectory(savedSettings.dataDirectory);
      setDataSaveState({ type: 'success', text: savedSettings.notice || '数据目录已生效。' });
    } catch (saveError) {
      setDataSaveState({ type: 'error', text: saveError.message });
    } finally {
      setSavingData(false);
    }
  }

  async function handleSaveProjectDirectory() {
    setSavingProject(true);
    setProjectSaveState(null);
    try {
      const savedSettings = await updateSettings({ projectDirectory: inputProjectDirectory.trim() });
      setCurrentProjectDirectory(savedSettings.projectDirectory);
      setInputProjectDirectory(savedSettings.projectDirectory);
      setProjectSaveState({ type: 'success', text: savedSettings.notice || '项目存放目录已生效。' });
      if (onProjectDirectoryChange) {
        onProjectDirectoryChange(savedSettings.projectDirectory);
      }
    } catch (saveError) {
      setProjectSaveState({ type: 'error', text: saveError.message });
    } finally {
      setSavingProject(false);
    }
  }

  /** 切换需求聚合目录模式：勾选即保存 */
  async function handleToggleWorkspaceLayout(changeEvent) {
    const checked = changeEvent.target.checked;
    setSavingWorkspace(true);
    setWorkspaceSaveState(null);
    try {
      const savedSettings = await updateSettings({ workspaceLayoutEnabled: checked });
      setWorkspaceLayoutEnabled(savedSettings.workspaceLayoutEnabled);
      setWorkspaceSaveState({
        type: 'success',
        text: savedSettings.notice || `需求聚合目录模式已${checked ? '开启' : '关闭'}。`
      });
      if (onWorkspaceLayoutChange) {
        onWorkspaceLayoutChange(savedSettings.workspaceLayoutEnabled);
      }
    } catch (saveError) {
      setWorkspaceSaveState({ type: 'error', text: saveError.message });
    } finally {
      setSavingWorkspace(false);
    }
  }

  async function handleSaveWorkspaceDirectory() {
    setSavingWorkspace(true);
    setWorkspaceSaveState(null);
    try {
      const savedSettings = await updateSettings({ workspaceDirectory: inputWorkspaceDirectory.trim() });
      setCurrentWorkspaceDirectory(savedSettings.workspaceDirectory);
      setInputWorkspaceDirectory(savedSettings.workspaceDirectory);
      setWorkspaceSaveState({ type: 'success', text: savedSettings.notice || '工作区文件目录已生效。' });
    } catch (saveError) {
      setWorkspaceSaveState({ type: 'error', text: saveError.message });
    } finally {
      setSavingWorkspace(false);
    }
  }

  async function handleSaveEditorCommand() {
    setSavingEditor(true);
    setEditorSaveState(null);
    try {
      const savedSettings = await updateSettings({ editorCommand: inputEditorCommand.trim() });
      setCurrentEditorCommand(savedSettings.editorCommand);
      setInputEditorCommand(savedSettings.editorCommand);
      setEditorSaveState({ type: 'success', text: savedSettings.notice || '编辑器命令已生效。' });
    } catch (saveError) {
      setEditorSaveState({ type: 'error', text: saveError.message });
    } finally {
      setSavingEditor(false);
    }
  }

  // 编辑器下拉：已安装的候选 + 当前值（不在候选中时也列出）+ 自定义兜底
  const availableEditorList = editorOptionList.filter((editorEntry) => editorEntry.available);
  const selectableEditorList = [...availableEditorList];
  if (currentEditorCommand && !selectableEditorList.some((editorEntry) => editorEntry.command === currentEditorCommand)) {
    selectableEditorList.push({ command: currentEditorCommand, label: `${currentEditorCommand}（当前）` });
  }
  const selectedEditorOptionValue = selectableEditorList.some(
    (editorEntry) => editorEntry.command === inputEditorCommand
  )
    ? inputEditorCommand
    : '__custom__';
  const selectedEditorLabel =
    (editorOptionList.find((editorEntry) => editorEntry.command === currentEditorCommand) || {}).label ||
    currentEditorCommand;

  const hasDataDirectoryChanged = inputDataDirectory.trim() !== currentDataDirectory;
  const hasProjectDirectoryChanged = inputProjectDirectory.trim() !== currentProjectDirectory;
  const hasWorkspaceDirectoryChanged = inputWorkspaceDirectory.trim() !== currentWorkspaceDirectory;
  const hasEditorCommandChanged = inputEditorCommand.trim() !== currentEditorCommand;

  return (
    <div>
      <div className="form-row">
        <label className="form-label">当前数据目录</label>
        <div className="settings-current-path">{currentDataDirectory || '（未初始化）'}</div>
        <div className="form-hint">
          任务记录、创建历史、最近主仓库与安装日志均保存在该目录下。修改后立即生效；历史数据保留在原目录，不会自动迁移。
        </div>
      </div>

      <div className="form-row">
        <label className="form-label" htmlFor="data-directory-input">新的数据目录</label>
        <input
          id="data-directory-input"
          className="form-input"
          type="text"
          value={inputDataDirectory}
          placeholder="例如 D:\softwares\worktree-manager"
          onChange={(changeEvent) => setInputDataDirectory(changeEvent.target.value)}
        />
      </div>

      <button
        type="button"
        className="button-primary"
        disabled={savingData || !inputDataDirectory.trim() || !hasDataDirectoryChanged}
        onClick={handleSaveDataDirectory}
      >
        {savingData ? '保存中...' : '保存数据目录'}
      </button>

      {dataSaveState ? (
        <div className={dataSaveState.type === 'error' ? 'alert-error' : 'alert-success'}>{dataSaveState.text}</div>
      ) : null}

      <div className="section-block">
        <div className="form-row">
          <label className="form-label">当前代码默认存储目录</label>
          <div className="settings-current-path">{currentProjectDirectory || '（未设置）'}</div>
          <div className="form-hint">
            目录选择器（主仓库、worktree 目标路径、需求项目等）打开时将默认定位到该目录，不必每次从盘符重新选择。
          </div>
        </div>

        <div className="form-row">
          <label className="form-label" htmlFor="project-directory-input">新的代码默认存储目录</label>
          <input
            id="project-directory-input"
            className="form-input"
            type="text"
            value={inputProjectDirectory}
            placeholder="例如 D:\project"
            onChange={(changeEvent) => setInputProjectDirectory(changeEvent.target.value)}
          />
        </div>

        <button
          type="button"
          className="button-primary"
          disabled={savingProject || !inputProjectDirectory.trim() || !hasProjectDirectoryChanged}
          onClick={handleSaveProjectDirectory}
        >
          {savingProject ? '保存中...' : '保存代码默认存储目录'}
        </button>

        {projectSaveState ? (
          <div className={projectSaveState.type === 'error' ? 'alert-error' : 'alert-success'}>
            {projectSaveState.text}
          </div>
        ) : null}
      </div>

      <div className="section-block">
        <div className="form-row">
          <label className="form-label">
            {workspaceLayoutEnabled ? '需求聚合根目录（worktree 代码与工作区文件统一存放）' : '当前工作区文件目录'}
          </label>
          <div className="settings-current-path">{currentWorkspaceDirectory || '（未设置）'}</div>
          <div className="form-hint">
            {workspaceLayoutEnabled
              ? '聚合模式下这是唯一目录设置：每个需求的 worktree 代码与 .code-workspace 工作区文件统一存放在 <该目录>\\<需求名称>\\ 下；目录选择器默认也定位到这里。'
              : '需求任务生成的 .code-workspace 工作区文件保存在该目录。默认位于数据目录下的 workspaces 子目录，可改为其他位置。'}
          </div>
        </div>

        <div className="form-row">
          <label className="radio-label">
            <input
              type="checkbox"
              checked={workspaceLayoutEnabled}
              disabled={savingWorkspace}
              onChange={handleToggleWorkspaceLayout}
            />
            需求聚合目录模式（推荐）：worktree 代码与工作区文件存放在同一需求目录下，目录以需求名称命名（如
            workspaces\【小蛋】直播任务…\admin-web）
          </label>
        </div>

        <div className="form-row">
          <label className="form-label" htmlFor="workspace-directory-input">新的工作区文件目录</label>
          <input
            id="workspace-directory-input"
            className="form-input"
            type="text"
            value={inputWorkspaceDirectory}
            placeholder="例如 D:\softwares\worktree-manager\workspaces"
            onChange={(changeEvent) => setInputWorkspaceDirectory(changeEvent.target.value)}
          />
        </div>

        <button
          type="button"
          className="button-primary"
          disabled={savingWorkspace || !inputWorkspaceDirectory.trim() || !hasWorkspaceDirectoryChanged}
          onClick={handleSaveWorkspaceDirectory}
        >
          {savingWorkspace ? '保存中...' : '保存工作区目录'}
        </button>

        {workspaceSaveState ? (
          <div className={workspaceSaveState.type === 'error' ? 'alert-error' : 'alert-success'}>
            {workspaceSaveState.text}
          </div>
        ) : null}
      </div>

      <div className="section-block">
        <div className="form-row">
          <label className="form-label" htmlFor="editor-select">用什么打开（已检测本机安装的编辑器）</label>
          <select
            id="editor-select"
            className="form-input"
            value={selectedEditorOptionValue}
            onChange={(changeEvent) => {
              const selectedValue = changeEvent.target.value;
              if (selectedValue !== '__custom__') {
                setInputEditorCommand(selectedValue);
              } else {
                setInputEditorCommand('');
              }
            }}
          >
            {selectableEditorList.map((editorEntry) => (
              <option key={editorEntry.command} value={editorEntry.command}>
                {editorEntry.label}（{editorEntry.command}）
              </option>
            ))}
            <option value="__custom__">自定义命令...</option>
          </select>
          <div className="form-hint">
            当前生效：{currentEditorCommand || 'code'}
            {selectedEditorLabel ? `（${selectedEditorLabel}）` : ''}。"打开"目录与工作区文件时使用该编辑器。
          </div>
        </div>

        {selectedEditorOptionValue === '__custom__' ? (
          <div className="form-row">
            <label className="form-label" htmlFor="editor-command-input">自定义编辑器命令</label>
            <input
              id="editor-command-input"
              className="form-input"
              type="text"
              value={inputEditorCommand}
              placeholder="填写编辑器的 CLI 命令，例如 codebuddy"
              onChange={(changeEvent) => setInputEditorCommand(changeEvent.target.value)}
            />
          </div>
        ) : null}

        <button
          type="button"
          className="button-primary"
          disabled={savingEditor || !inputEditorCommand.trim() || !hasEditorCommandChanged}
          onClick={handleSaveEditorCommand}
        >
          {savingEditor ? '保存中...' : '保存编辑器命令'}
        </button>

        {editorSaveState ? (
          <div className={editorSaveState.type === 'error' ? 'alert-error' : 'alert-success'}>
            {editorSaveState.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}
