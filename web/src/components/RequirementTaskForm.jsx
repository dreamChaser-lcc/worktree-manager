import React, { useEffect, useRef, useState } from 'react';
import { DirectoryPicker } from './DirectoryPicker.jsx';
import { WorktreeQuickCreateDialog } from './WorktreeQuickCreateDialog.jsx';
import { fetchWorktreeList, createRequirementTask, updateRequirementTask } from '../api/client.js';

let projectRowSequence = 0;

/** 从目录路径取最后一段作为项目名称（如 D:\project\admin-web → admin-web） */
export function deriveProjectNameFromPath(directoryPath) {
  const pathSegmentList = String(directoryPath || '').split(/[\\/]+/).filter(Boolean);
  return pathSegmentList.length > 0 ? pathSegmentList[pathSegmentList.length - 1] : '';
}

/** 计算需求聚合目录：<工作区目录>\<需求名称>（需求名称做文件名安全化） */
export function buildRequirementDirectoryPath(workspaceDirectoryPath, requirementNameText) {
  if (!workspaceDirectoryPath || !requirementNameText) {
    return '';
  }
  const safeName = String(requirementNameText)
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!safeName) {
    return '';
  }
  const baseDirectory = String(workspaceDirectoryPath).replace(/[\\/]+$/, '');
  return `${baseDirectory}\\${safeName}`;
}

function createEmptyProjectRow() {
  projectRowSequence += 1;
  return {
    rowKey: `project-row-${projectRowSequence}`,
    projectName: '',
    repoPath: '',
    worktreePath: '',
    worktreeOptions: [],
    optionsLoading: false
  };
}

function buildWorktreeSelectOptions(row) {
  const optionList = (row.worktreeOptions || []).map((worktreeEntry) => ({
    value: worktreeEntry.path,
    label: `${worktreeEntry.isMain ? '[主目录] ' : ''}分支 ${worktreeEntry.branch || '(detached)'} — ${worktreeEntry.path}`
  }));
  if (row.worktreePath && !optionList.some((option) => option.value === row.worktreePath)) {
    optionList.unshift({ value: row.worktreePath, label: `${row.worktreePath}（不在当前列表，可能已删除）` });
  }
  return optionList;
}

/**
 * 需求任务详情表单：需求链接 / 分支名称 / 涉及项目（项目名+主仓库+关联 worktree）/ 预留备注。
 * 项目行的 worktree 下拉来自该主仓库的真实 worktree 列表；分支名一致时自动预选。
 */
/** 从粘贴文本中提取 TAPD 等需求链接与标题（标题与链接可同框粘贴，自动拆分） */
function parseRequirementInput(inputText) {
  const urlMatch = String(inputText || '').match(/https?:\/\/[^\s]+/);
  if (!urlMatch) {
    return null;
  }
  const parsedUrl = urlMatch[0];
  const remainingNameText = String(inputText || '')
    .replace(parsedUrl, ' ')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
  return { url: parsedUrl, name: remainingNameText };
}

export function RequirementTaskForm({
  initialRecord,
  initialBrowsePath,
  workspaceDirectory,
  workspaceLayoutEnabled,
  onCancel,
  onSaved
}) {
  const [requirementName, setRequirementName] = useState(initialRecord ? initialRecord.requirementName || '' : '');
  const [requirementUrl, setRequirementUrl] = useState(initialRecord ? initialRecord.requirementUrl : '');
  const [branchName, setBranchName] = useState(initialRecord ? initialRecord.branchName : '');
  const [reservedContent, setReservedContent] = useState(initialRecord ? initialRecord.reservedContent || '' : '');
  const [projectRows, setProjectRows] = useState(
    initialRecord && initialRecord.projectList && initialRecord.projectList.length > 0
      ? initialRecord.projectList.map((projectEntry) => ({
          ...createEmptyProjectRow(),
          projectName: projectEntry.projectName,
          repoPath: projectEntry.repoPath,
          worktreePath: projectEntry.worktreePath || ''
        }))
      : [createEmptyProjectRow()]
  );
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  // 保存后生成 .code-workspace 工作区文件（默认勾选）
  const [generateWorkspace, setGenerateWorkspace] = useState(true);
  // 当前打开"快捷创建 worktree"弹层的项目行 rowKey
  const [quickCreateRowKey, setQuickCreateRowKey] = useState(null);
  const branchNameRef = useRef(branchName);
  branchNameRef.current = branchName;

  // 为已有主仓库的项目行加载 worktree 选项（编辑回显/新建后手动选择）
  useEffect(() => {
    projectRows.forEach((row, rowIndex) => {
      if (row.repoPath && row.worktreeOptions.length === 0 && !row.optionsLoading && !row.optionsLoaded) {
        loadWorktreeOptions(row.rowKey, row.repoPath);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 分支名称变化：为尚未关联的行按分支名自动预选
  useEffect(() => {
    setProjectRows((previousRows) =>
      previousRows.map((row) => {
        if (row.worktreePath) {
          return row;
        }
        const matchedOption = (row.worktreeOptions || []).find(
          (option) => option.branch === branchName && option.path !== row.repoPath
        );
        return matchedOption ? { ...row, worktreePath: matchedOption.path } : row;
      })
    );
  }, [branchName]);

  function loadWorktreeOptions(rowKey, repoPathValue) {
    setProjectRows((previousRows) =>
      previousRows.map((row) => (row.rowKey === rowKey ? { ...row, optionsLoading: true } : row))
    );
    fetchWorktreeList(repoPathValue)
      .then((listData) => {
        setProjectRows((previousRows) =>
          previousRows.map((row) => {
            if (row.rowKey !== rowKey) {
              return row;
            }
            const optionList = listData.worktrees || [];
            let nextWorktreePath = row.worktreePath;
            // 未关联时按需求分支名自动预选（排除主仓库自身路径）
            if (!nextWorktreePath) {
              const matchedOption = optionList.find(
                (option) => option.branch === branchNameRef.current && option.path !== repoPathValue
              );
              if (matchedOption) {
                nextWorktreePath = matchedOption.path;
              }
            }
            return { ...row, worktreeOptions: optionList, optionsLoading: false, optionsLoaded: true, worktreePath: nextWorktreePath };
          })
        );
      })
      .catch(() => {
        // 无效主仓库：选项留空即可，不做阻断
        setProjectRows((previousRows) =>
          previousRows.map((row) => (row.rowKey === rowKey ? { ...row, optionsLoading: false, optionsLoaded: true } : row))
        );
      });
  }

  function updateProjectRow(rowKey, fieldUpdates) {
    setProjectRows((previousRows) =>
      previousRows.map((row) => (row.rowKey === rowKey ? { ...row, ...fieldUpdates } : row))
    );
  }

  function handleRepoPathChange(rowKey, selectedRepoPath) {
    // 项目名称始终跟随所选目录的最后一段（如 D:\project\admin-web → admin-web）
    const rowUpdates = {
      repoPath: selectedRepoPath,
      projectName: deriveProjectNameFromPath(selectedRepoPath),
      worktreeOptions: [],
      worktreePath: '',
      optionsLoaded: false
    };
    updateProjectRow(rowKey, rowUpdates);
    if (selectedRepoPath) {
      loadWorktreeOptions(rowKey, selectedRepoPath);
    }
  }

  function handleAddProjectRow() {
    setProjectRows((previousRows) => [...previousRows, createEmptyProjectRow()]);
  }

  function handleRemoveProjectRow(rowKey) {
    setProjectRows((previousRows) =>
      previousRows.length > 1 ? previousRows.filter((row) => row.rowKey !== rowKey) : previousRows
    );
  }

  /** 需求链接/需求名称输入：检测到粘贴的“标题 + 链接”组合时自动拆分填入两个字段 */
  function handleRequirementFieldChange(fieldName, inputText) {
    const parsedRequirement = parseRequirementInput(inputText);
    if (parsedRequirement) {
      setRequirementUrl(parsedRequirement.url);
      if (parsedRequirement.name) {
        setRequirementName(parsedRequirement.name);
      }
      return;
    }
    // 纯文本无链接：按当前编辑的字段回填
    if (fieldName === 'name') {
      setRequirementName(inputText);
    } else {
      setRequirementUrl(inputText);
    }
  }

  async function handleSave() {
    const trimmedUrl = requirementUrl.trim();
    const trimmedBranchName = branchName.trim();
    if (!trimmedUrl) {
      setFormError('需求链接不能为空');
      return;
    }
    if (!trimmedBranchName) {
      setFormError('分支名称不能为空');
      return;
    }
    for (let rowIndex = 0; rowIndex < projectRows.length; rowIndex += 1) {
      const row = projectRows[rowIndex];
      if (!row.projectName.trim() || !row.repoPath.trim()) {
        setFormError(`第 ${rowIndex + 1} 个项目的名称与主仓库路径不能为空`);
        return;
      }
    }
    setFormError(null);
    setSaving(true);
    const taskPayload = {
      requirementName: requirementName.trim(),
      requirementUrl: trimmedUrl,
      branchName: trimmedBranchName,
      reservedContent: reservedContent.trim(),
      projectList: projectRows.map((row) => ({
        projectName: row.projectName.trim(),
        repoPath: row.repoPath.trim(),
        worktreePath: row.worktreePath || null
      })),
      generateWorkspace
    };
    try {
      const responseData = initialRecord
        ? await updateRequirementTask(initialRecord.id, taskPayload)
        : await createRequirementTask(taskPayload);
      onSaved(responseData);
    } catch (saveError) {
      setFormError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="form-row">
        <label className="form-label" htmlFor="requirement-name-input">需求名称</label>
        <input
          id="requirement-name-input"
          className="form-input"
          type="text"
          value={requirementName}
          placeholder="例如：【小蛋】直播任务支持区分不同路径玩法"
          onChange={(changeEvent) => handleRequirementFieldChange('name', changeEvent.target.value)}
        />
      </div>

      <div className="form-row">
        <label className="form-label" htmlFor="requirement-url-input">需求链接</label>
        <input
          id="requirement-url-input"
          className="form-input"
          type="text"
          value={requirementUrl}
          placeholder="粘贴 TAPD 链接；若同时粘贴了“标题 + 链接”会自动拆分填入需求名称"
          onChange={(changeEvent) => handleRequirementFieldChange('url', changeEvent.target.value)}
        />
        <div className="form-hint">
          支持直接粘贴“需求名称 + 链接”整段文本（如从 TAPD 复制的标题和地址），会自动拆分填入上方两个字段
        </div>
      </div>

      <div className="form-row">
        <label className="form-label" htmlFor="requirement-branch-input">分支名称</label>
        <input
          id="requirement-branch-input"
          className="form-input"
          type="text"
          value={branchName}
          placeholder="该需求对应的开发分支"
          onChange={(changeEvent) => setBranchName(changeEvent.target.value)}
        />
        <div className="form-hint">项目行选择主仓库后，与此分支同名的 worktree 会自动预选</div>
      </div>

      <div className="form-row">
        <label className="form-label">涉及项目（{projectRows.length}）</label>
        {projectRows.map((row) => (
          <div key={row.rowKey} className="requirement-project-block">
            <div className="requirement-project-header">
              <input
                className="form-input project-name-input"
                type="text"
                value={row.projectName}
                placeholder="项目名称"
                onChange={(changeEvent) => updateProjectRow(row.rowKey, { projectName: changeEvent.target.value })}
              />
              {projectRows.length > 1 ? (
                <button type="button" className="button-danger" onClick={() => handleRemoveProjectRow(row.rowKey)}>
                  移除项目
                </button>
              ) : null}
            </div>
            <DirectoryPicker
              label="主仓库路径"
              value={row.repoPath}
              onChange={(selectedPath) => handleRepoPathChange(row.rowKey, selectedPath)}
              initialPath={initialBrowsePath}
            />
            <div className="form-row">
              <div className="worktree-select-row">
                <label className="form-label" htmlFor={`worktree-select-${row.rowKey}`}>关联 worktree</label>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={!row.repoPath}
                  onClick={() => setQuickCreateRowKey(row.rowKey)}
                >
                  创建 worktree
                </button>
              </div>
              <select
                id={`worktree-select-${row.rowKey}`}
                className="form-input worktree-select"
                value={row.worktreePath}
                onChange={(changeEvent) => updateProjectRow(row.rowKey, { worktreePath: changeEvent.target.value })}
              >
                <option value="">{row.optionsLoading ? '加载中...' : '未关联（可稍后创建后再编辑挂载）'}</option>
                {buildWorktreeSelectOptions(row).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>
        ))}
        <button type="button" className="button-secondary" onClick={handleAddProjectRow}>
          添加项目
        </button>
      </div>

      <div className="form-row">
        <label className="form-label" htmlFor="reserved-content-input">备注（预留字段）</label>
        <textarea
          id="reserved-content-input"
          className="reserved-textarea"
          value={reservedContent}
          placeholder="预留信息，可填写需求背景、联调约定等"
          onChange={(changeEvent) => setReservedContent(changeEvent.target.value)}
        />
      </div>

      <div className="form-row">
        <label className="radio-label">
          <input
            type="checkbox"
            checked={generateWorkspace}
            onChange={(changeEvent) => setGenerateWorkspace(changeEvent.target.checked)}
          />
          保存后生成工作区文件（.code-workspace，聚合各项目已关联的 worktree）
        </label>
      </div>

      {formError ? <div className="alert-error">{formError}</div> : null}

      <div className="picker-footer">
        <button type="button" className="button-secondary" onClick={onCancel}>取消</button>
        <button type="button" className="button-primary" disabled={saving} onClick={handleSave}>
          {saving ? '保存中...' : '保存'}
        </button>
      </div>

      {quickCreateRowKey ? (
        <WorktreeQuickCreateDialog
          repoPath={(projectRows.find((row) => row.rowKey === quickCreateRowKey) || {}).repoPath || ''}
          defaultBranchName={branchName}
          projectDirectory={initialBrowsePath}
          requirementDirectory={
            workspaceLayoutEnabled ? buildRequirementDirectoryPath(workspaceDirectory, requirementName || branchName) : ''
          }
          suggestSubdirectoryName={deriveProjectNameFromPath(
            (projectRows.find((row) => row.rowKey === quickCreateRowKey) || {}).repoPath || ''
          )}
          onClose={() => setQuickCreateRowKey(null)}
          onCreated={(createdWorktreePath) => {
            updateProjectRow(quickCreateRowKey, { worktreePath: createdWorktreePath });
            const targetRow = projectRows.find((row) => row.rowKey === quickCreateRowKey);
            if (targetRow && targetRow.repoPath) {
              loadWorktreeOptions(quickCreateRowKey, targetRow.repoPath);
            }
            setQuickCreateRowKey(null);
          }}
        />
      ) : null}
    </div>
  );
}
