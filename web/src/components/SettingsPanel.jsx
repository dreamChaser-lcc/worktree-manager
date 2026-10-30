import React, { useEffect, useState } from 'react';
import { SearchableSelect } from './SearchableSelect.jsx';
import { DirectoryPicker } from './DirectoryPicker.jsx';
import { fetchSettings, updateSettings, fetchInstalledEditors } from '../api/client.js';

/**
 * 设置面板：数据根目录（任务/历史/日志存储位置）与项目存放目录（目录选择器默认定位）。
 * 两个设置相互独立、各自保存；数据目录修改立即生效且不迁移历史数据。
 */
export function SettingsPanel({ onProjectDirectoryChange, onWorkspaceLayoutChange }) {
  const [currentDataDirectory, setCurrentDataDirectory] = useState('');
  const [inputDataDirectory, setInputDataDirectory] = useState('');
  // 数据目录模式：standalone = 独立/默认目录（现状）；app-data = 程序目录下 data
  const [dataLocationMode, setDataLocationMode] = useState('standalone');
  const [appDataDirectoryPath, setAppDataDirectoryPath] = useState('');
  const [savingLocationMode, setSavingLocationMode] = useState(false);
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
        // 输入框回填 settings.json 记录的自定义目录（app-data 模式下与生效目录区分，避免误存程序目录路径）
        setInputDataDirectory(settingsData.configuredDataDirectory || '');
        setDataLocationMode(settingsData.dataLocationMode === 'app-data' ? 'app-data' : 'standalone');
        setAppDataDirectoryPath(settingsData.appDataDirectoryPath || '');
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
      // 自定义目录即独立目录模式（后端 changeDataRoot 同步落 dataLocationMode=standalone）
      const savedSettings = await updateSettings({
        dataDirectory: inputDataDirectory.trim(),
        dataLocationMode: 'standalone'
      });
      setCurrentDataDirectory(savedSettings.dataDirectory);
      setDataLocationMode(savedSettings.dataLocationMode || 'standalone');
      setInputDataDirectory(inputDataDirectory.trim());
      setDataSaveState({ type: 'success', text: savedSettings.notice || '数据目录已生效。' });
    } catch (saveError) {
      setDataSaveState({ type: 'error', text: saveError.message });
    } finally {
      setSavingData(false);
    }
  }

  /** 切换数据目录模式（独立目录 ↔ 程序目录下 data），立即生效，历史数据保留原目录 */
  async function handleSwitchDataLocation(nextMode) {
    if (nextMode === dataLocationMode) {
      return;
    }
    setSavingLocationMode(true);
    setDataSaveState(null);
    try {
      const savedSettings = await updateSettings({ dataLocationMode: nextMode });
      setCurrentDataDirectory(savedSettings.dataDirectory);
      setDataLocationMode(savedSettings.dataLocationMode || nextMode);
      setDataSaveState({ type: 'success', text: savedSettings.notice || '数据目录模式已切换。' });
    } catch (switchError) {
      setDataSaveState({ type: 'error', text: switchError.message });
    } finally {
      setSavingLocationMode(false);
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
        <label className="form-label">数据目录位置</label>
        <label className="radio-label">
          <input
            type="radio"
            name="dataLocationMode"
            checked={dataLocationMode === 'standalone'}
            onChange={() => handleSwitchDataLocation('standalone')}
            disabled={savingLocationMode || dataLocationMode === 'standalone'}
          />
          独立数据目录（默认 D:\softwares\worktree-manager，D 盘缺失自动回退到用户目录；下方可自定义）
        </label>
        <label className="radio-label">
          <input
            type="radio"
            name="dataLocationMode"
            checked={dataLocationMode === 'app-data'}
            onChange={() => handleSwitchDataLocation('app-data')}
            disabled={savingLocationMode || dataLocationMode === 'app-data'}
          />
          程序目录下 data（随程序目录携带：{appDataDirectoryPath || '（程序根）\data'}）
        </label>
      </div>

      <DirectoryPicker
        label="自定义数据目录（弹窗选择）"
        value={dataLocationMode === 'app-data' ? '' : inputDataDirectory}
        onChange={(selectedPath) => setInputDataDirectory(selectedPath)}
        initialPath={inputDataDirectory || currentDataDirectory}
        hintText={
          dataLocationMode === 'app-data'
            ? '当前为程序目录下 data 模式；如需自定义目录，先切回「独立数据目录」。选择后点击保存，记录与任务日志会自动迁移。'
            : '选择后点击保存，记录与任务日志会自动迁移到新目录；留空表示使用默认目录。'
        }
      />

      <button
        type="button"
        className="button-primary"
        disabled={savingData || dataLocationMode === 'app-data' || !inputDataDirectory.trim() || !hasDataDirectoryChanged}
        onClick={handleSaveDataDirectory}
      >
        {savingData ? '保存中...' : '保存自定义数据目录'}
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

        <DirectoryPicker
          label="新的代码默认存储目录（弹窗选择）"
          value={inputProjectDirectory}
          onChange={(selectedPath) => setInputProjectDirectory(selectedPath)}
          initialPath={currentProjectDirectory}
          hintText="选择后点击保存，目录选择器（主仓库、worktree 目标路径、需求项目等）将默认定位到该目录。"
        />

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

        <DirectoryPicker
          label="新的工作区文件目录（弹窗选择）"
          value={inputWorkspaceDirectory}
          onChange={(selectedPath) => setInputWorkspaceDirectory(selectedPath)}
          initialPath={currentWorkspaceDirectory}
          hintText={
            workspaceLayoutEnabled
              ? '聚合模式下这是唯一目录设置：worktree 代码与 .code-workspace 统一存放在 <该目录>\\<需求名称>\\ 下。'
              : '选择后点击保存，新生成的 .code-workspace 工作区文件将保存到该目录。'
          }
        />

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
          <label className="form-label">用什么打开（已检测本机安装的编辑器）</label>
          <SearchableSelect
            value={selectedEditorOptionValue}
            onChange={(selectedValue) => {
              if (selectedValue !== '__custom__') {
                setInputEditorCommand(selectedValue);
              } else {
                setInputEditorCommand('');
              }
            }}
            placeholder="请选择编辑器（或自定义命令）"
            filterPlaceholder="输入筛选编辑器..."
            emptyText="无匹配编辑器"
            options={[
              ...selectableEditorList.map((editorEntry) => ({
                value: editorEntry.command,
                label: `${editorEntry.label}（${editorEntry.command}）`
              })),
              { value: '__custom__', label: '自定义命令...' }
            ]}
          />
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
