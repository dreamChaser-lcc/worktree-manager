import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * 可搜索下拉：原生 select 的替代，支持输入过滤、键盘导航（↑↓/Enter/Esc）、
 * 分组展示（option.group 相邻同组自动归组，替代 optgroup）、禁选项（option.disabled）。
 * options 结构：[{ value, label?, disabled?, group? }]，label 缺省取 String(value)。
 * 点击外部自动收起；value 无匹配项时触发按钮显示 placeholder。
 */
export function SearchableSelect({
  value,
  options,
  onChange,
  placeholder = '请选择',
  filterPlaceholder = '输入筛选...',
  emptyText = '无匹配项',
  disabled = false,
  id
}) {
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootReference = useRef(null);

  const selectedEntry = options.find((optionEntry) => optionEntry.value === value);
  const displayText = selectedEntry ? selectedEntry.label ?? String(selectedEntry.value) : '';

  // 按过滤词筛选后重建分组结构（分组标题只在组内有命中项时出现）
  const visibleItemList = useMemo(() => {
    const filterLowerText = filterText.trim().toLowerCase();
    const matchedEntryList = options.filter((optionEntry) => {
      const label = optionEntry.label ?? String(optionEntry.value);
      return filterLowerText === '' || label.toLowerCase().includes(filterLowerText);
    });
    const renderItemList = [];
    let lastGroupName = null;
    for (const optionEntry of matchedEntryList) {
      if (optionEntry.group && optionEntry.group !== lastGroupName) {
        renderItemList.push({ type: 'group', key: `group:${optionEntry.group}`, label: optionEntry.group });
        lastGroupName = optionEntry.group;
      }
      renderItemList.push({
        type: 'option',
        key: `option:${String(optionEntry.value)}`,
        value: optionEntry.value,
        label: optionEntry.label ?? String(optionEntry.value),
        disabled: Boolean(optionEntry.disabled)
      });
    }
    return renderItemList;
  }, [options, filterText]);

  // 可键盘导航的选项下标集合（跳过分组标题与禁选项）
  const navigableIndexList = visibleItemList
    .map((itemEntry, itemIndex) => (itemEntry.type === 'option' && !itemEntry.disabled ? itemIndex : -1))
    .filter((itemIndex) => itemIndex >= 0);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    setActiveIndex(navigableIndexList.length > 0 ? navigableIndexList[0] : -1);
    function handleDocumentMouseDown(mouseEvent) {
      if (rootReference.current && !rootReference.current.contains(mouseEvent.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function toggleOpen() {
    if (disabled) {
      return;
    }
    setFilterText('');
    setOpen(!open);
  }

  function selectOption(optionEntry) {
    if (optionEntry.disabled) {
      return;
    }
    onChange(optionEntry.value);
    setOpen(false);
  }

  function moveActiveIndex(stepOffset) {
    if (navigableIndexList.length === 0) {
      return;
    }
    const currentPosition = navigableIndexList.indexOf(activeIndex);
    const nextPosition =
      currentPosition === -1
        ? 0
        : (currentPosition + stepOffset + navigableIndexList.length) % navigableIndexList.length;
    setActiveIndex(navigableIndexList[nextPosition]);
  }

  function handleFilterKeyDown(keyboardEvent) {
    if (keyboardEvent.key === 'ArrowDown') {
      keyboardEvent.preventDefault();
      moveActiveIndex(1);
    } else if (keyboardEvent.key === 'ArrowUp') {
      keyboardEvent.preventDefault();
      moveActiveIndex(-1);
    } else if (keyboardEvent.key === 'Enter') {
      keyboardEvent.preventDefault();
      const activeEntry = visibleItemList[activeIndex];
      if (activeEntry && activeEntry.type === 'option' && !activeEntry.disabled) {
        selectOption(activeEntry);
      }
    } else if (keyboardEvent.key === 'Escape') {
      keyboardEvent.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="searchable-select" ref={rootReference}>
      <button
        type="button"
        id={id}
        className="form-input searchable-select-trigger"
        disabled={disabled}
        onClick={toggleOpen}
        title={displayText || placeholder}
      >
        <span className={displayText ? 'searchable-select-trigger-text' : 'searchable-select-trigger-text searchable-select-placeholder'}>
          {displayText || placeholder}
        </span>
        <span className="searchable-select-arrow">▾</span>
      </button>

      {open ? (
        <div className="searchable-select-dropdown">
          <input
            className="searchable-select-filter"
            type="text"
            autoFocus
            placeholder={filterPlaceholder}
            value={filterText}
            onChange={(changeEvent) => setFilterText(changeEvent.target.value)}
            onKeyDown={handleFilterKeyDown}
          />
          <div className="searchable-select-list">
            {visibleItemList.length === 0 ? <div className="searchable-select-empty">{emptyText}</div> : null}
            {visibleItemList.map((itemEntry, itemIndex) =>
              itemEntry.type === 'group' ? (
                <div key={itemEntry.key} className="searchable-select-group">
                  {itemEntry.label}
                </div>
              ) : (
                <div
                  key={itemEntry.key}
                  className={[
                    'searchable-select-option',
                    itemIndex === activeIndex ? 'searchable-select-option-active' : '',
                    itemEntry.value === value ? 'searchable-select-option-selected' : '',
                    itemEntry.disabled ? 'searchable-select-option-disabled' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onMouseEnter={() => setActiveIndex(itemIndex)}
                  onClick={() => selectOption(itemEntry)}
                >
                  {itemEntry.label}
                </div>
              )
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
