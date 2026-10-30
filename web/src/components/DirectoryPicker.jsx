import React, { useEffect, useState } from 'react';
import { fetchDriveList, fetchDirectoryListing } from '../api/client.js';

/**
 * 目录选择器：只读输入框 + 弹层目录树。
 * 从盘符逐级进入，选中"当前目录"回填绝对路径。
 * allowNewSubdirectory：允许在当前目录下拼接一个尚不存在的新子目录名
 * （用于 worktree 目标路径——目标目录通常还没建）。
 */
export function DirectoryPicker({ label, value, onChange, hintText, allowNewSubdirectory }) {
  const [pickerVisible, setPickerVisible] = useState(false);
  const [currentPath, setCurrentPath] = useState(null);
  const [parentPath, setParentPath] = useState(null);
  const [directoryList, setDirectoryList] = useState([]);
  const [driveList, setDriveList] = useState([]);
  const [pickerError, setPickerError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [newSubdirectoryName, setNewSubdirectoryName] = useState('');

  useEffect(() => {
    if (!pickerVisible) {
      return;
    }
    if (!currentPath) {
      // 首次打开：列驱动器
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
              {currentPath && parentPath ? (
                <button type="button" className="button-secondary" onClick={() => setCurrentPath(parentPath)}>
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
