import React, { useEffect, useRef, useState } from 'react';
import { fetchDriveList, fetchDirectoryListing } from '../api/client.js';

/**
 * 目录选择器：只读输入框 + 弹层目录树。
 * 从盘符逐级进入，选中"当前目录"回填绝对路径。
 * initialPath：打开时默认定位的起始目录（如项目存放目录），仅首次打开生效，
 * 之后保留用户浏览位置；盘符根目录的"上一级"回到盘符列表。
 * allowNewSubdirectory：允许在当前目录下拼接一个尚不存在的新子目录名
 * （用于 worktree 目标路径——目标目录通常还没建）。
 */
/** 计算初始路径中尚不存在的子路径尾巴（相对最终可列出的祖先目录），如 D:\ws\需求 → D:\ws 时返回 "需求" */
function getMissingTail(fullPath, existingDirectoryPath) {
  const normalizedFull = String(fullPath || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const normalizedExisting = String(existingDirectoryPath || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  if (!normalizedExisting || !normalizedFull.startsWith(normalizedExisting)) {
    return '';
  }
  return String(fullPath || '').replace(/\//g, '\\').slice(normalizedExisting.length).replace(/^\\+/, '');
}

export function DirectoryPicker({
  label,
  value,
  onChange,
  hintText,
  allowNewSubdirectory,
  initialPath,
  suggestSubdirectoryName
}) {
  const [pickerVisible, setPickerVisible] = useState(false);
  const [currentPath, setCurrentPath] = useState(null);
  const [parentPath, setParentPath] = useState(null);
  const [directoryList, setDirectoryList] = useState([]);
  const [driveList, setDriveList] = useState([]);
  const [pickerError, setPickerError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [newSubdirectoryName, setNewSubdirectoryName] = useState('');
  const initialPathAppliedRef = useRef(false);

  // 打开选择器时预填建议的子目录名（如按项目名/需求名建子目录）
  useEffect(() => {
    if (pickerVisible) {
      setNewSubdirectoryName(suggestSubdirectoryName || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerVisible]);

  useEffect(() => {
    if (!pickerVisible) {
      return;
    }
    if (!currentPath && initialPath && !initialPathAppliedRef.current) {
      // 首次打开定位到初始目录；目录尚不存在时逐级向上找到存在的祖先目录浏览，
      // 缺失的子路径并入"新建子目录"输入（不静默创建目录，由用户确认后随创建动作生成）
      initialPathAppliedRef.current = true;
      let cancelled = false;
      (async () => {
        let probePath = initialPath;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            const data = await fetchDirectoryListing(probePath);
            if (cancelled) {
              return;
            }
            setCurrentPath(data.currentPath);
            setDirectoryList(data.directories);
            setParentPath(data.parentPath);
            setPickerError(null);
            const missingTail = getMissingTail(initialPath, data.currentPath);
            const combinedSubdirectoryName = [missingTail, suggestSubdirectoryName].filter(Boolean).join('\\');
            if (combinedSubdirectoryName) {
              setNewSubdirectoryName(combinedSubdirectoryName);
            }
            return;
          } catch {
            const parentPath = probePath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
            if (!parentPath || parentPath === probePath) {
              break;
            }
            probePath = parentPath;
          }
        }
        if (!cancelled) {
          setPickerError('初始目录不可用，请从盘符重新选择');
        }
      })();
      return;
    }
    if (!currentPath) {
      // 列驱动器
      fetchDriveList()
        .then((data) => setDriveList(data.drives))
        .catch((error) => setPickerError(error.message));
      return;
    }
    setLoading(true);
    fetchDirectoryListing(currentPath)
      .then((data) => {
        setDirectoryList(data.directories);
        setParentPath(data.parentPath);
        setPickerError(null);
      })
      .catch((error) => setPickerError(error.message))
      .finally(() => setLoading(false));
  }, [pickerVisible, currentPath]);

  function confirmCurrentDirectory() {
    if (!currentPath) {
      return;
    }
    const trimmedSubdirectoryName = newSubdirectoryName.trim();
    if (allowNewSubdirectory && trimmedSubdirectoryName) {
      const separator = currentPath.endsWith('\\') || currentPath.endsWith('/') ? '' : '\\';
      onChange(`${currentPath}${separator}${trimmedSubdirectoryName}`);
    } else {
      onChange(currentPath);
    }
    setNewSubdirectoryName('');
    setPickerVisible(false);
  }

  return (
    <div className="form-row">
      <label className="form-label">{label}</label>
      <div className="picker-input-row">
        <input className="form-input" type="text" value={value || ''} placeholder="请选择目录" readOnly />
        <button type="button" className="button-secondary" onClick={() => setPickerVisible(true)}>
          浏览
        </button>
      </div>
      {hintText ? <div className="form-hint">{hintText}</div> : null}

      {pickerVisible ? (
        <div className="picker-overlay" onClick={() => setPickerVisible(false)}>
          <div className="picker-dialog" onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <div className="picker-toolbar">
              <span className="picker-current-path" title={currentPath || ''}>
                {currentPath || '请选择驱动器'}
              </span>
              {currentPath ? (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setCurrentPath(parentPath || null)}
                >
                  上一级
                </button>
              ) : null}
            </div>

            {pickerError ? <div className="alert-error">{pickerError}</div> : null}
            {loading ? <div className="form-hint">加载中...</div> : null}

            <div className="picker-list">
              {!currentPath
                ? driveList.map((driveItem) => (
                    <div
                      key={driveItem.path}
                      className="picker-item"
                      onClick={() => setCurrentPath(driveItem.path)}
                    >
                      {driveItem.name}
                    </div>
                  ))
                : directoryList.map((directoryItem) => (
                    <div
                      key={directoryItem.path}
                      className="picker-item"
                      onClick={() => setCurrentPath(directoryItem.path)}
                    >
                      {directoryItem.name}
                    </div>
                  ))}
              {currentPath && !loading && directoryList.length === 0 ? (
                <div className="picker-item picker-item-empty">（无子目录）</div>
              ) : null}
            </div>

            {allowNewSubdirectory && currentPath ? (
              <input
                className="form-input new-subdir-input"
                type="text"
                placeholder="（可选）在当前目录下新建子目录名，回填为 目标路径"
                value={newSubdirectoryName}
                onChange={(changeEvent) => setNewSubdirectoryName(changeEvent.target.value)}
              />
            ) : null}

            <div className="picker-footer">
              <button type="button" className="button-secondary" onClick={() => setPickerVisible(false)}>
                取消
              </button>
              <button
                type="button"
                className="button-primary"
                disabled={!currentPath}
                onClick={confirmCurrentDirectory}
              >
                选择当前目录
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
