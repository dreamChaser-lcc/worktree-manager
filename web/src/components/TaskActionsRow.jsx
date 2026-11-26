import React, { useEffect, useRef, useState } from 'react';

const LIFECYCLE_OPTION_LIST = ['待开发', '开发中', '测试中', '已发布'];

const STAGE_CLASS_MAP = {
  待开发: 'stage-tag-wait',
  开发中: 'stage-tag-dev',
  测试中: 'stage-tag-test',
  已发布: 'stage-tag-published'
};

/** ISO 时间 → 本地 YYYY-MM-DD HH:mm（仅用于展示删除时间） */
function formatTimestamp(isoText) {
  if (!isoText) {
    return '';
  }
  const dateValue = new Date(isoText);
  if (Number.isNaN(dateValue.getTime())) {
    return String(isoText);
  }
  const padText = (value) => String(value).padStart(2, '0');
  return [
    `${dateValue.getFullYear()}-${padText(dateValue.getMonth() + 1)}-${padText(dateValue.getDate())}`,
    `${padText(dateValue.getHours())}:${padText(dateValue.getMinutes())}`
  ].join(' ');
}

/** 生命周期下拉：fixed 定位浮层（不受表格滚动容器裁剪），点击外部关闭 */
function LifecycleMenu({ anchorRect, currentLifecycle, onSelect, onClose }) {
  const menuReference = useRef(null);
  const [menuStyle, setMenuStyle] = useState(null);

  useEffect(() => {
    // 4 项 × 约 30px + 上下内边距 ≈ 136
    const menuHeight = 136;
    const menuWidth = 126;
    let top = anchorRect.bottom + 4;
    if (top + menuHeight > window.innerHeight - 8) {
      top = anchorRect.top - menuHeight - 4;
    }
    setMenuStyle({
      top: Math.max(8, top),
      left: Math.min(Math.max(8, anchorRect.left), window.innerWidth - menuWidth - 8)
    });
    function handleDocumentMouseDown(mouseEvent) {
      if (menuReference.current && !menuReference.current.contains(mouseEvent.target)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!menuStyle) {
    return null;
  }

  return (
    <div
      ref={menuReference}
      className="stage-tag-menu"
      style={{ position: 'fixed', top: menuStyle.top, left: menuStyle.left, zIndex: 60 }}
    >
      {LIFECYCLE_OPTION_LIST.map((optionItem) => (
        <button
          key={optionItem}
          type="button"
          className={[
            'stage-tag-menu-item',
            currentLifecycle === optionItem ? 'stage-tag-menu-item-active' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => onSelect(optionItem)}
        >
          {optionItem}
        </button>
      ))}
    </div>
  );
}

/**
 * 需求任务的"操作行"：渲染在主行与备注行之间，平铺展示操作按钮。
 * 生命周期徽标可点击切换（与明细里的下拉写同一个 lifecycle 接口，只有一处状态来源）。
 * 已删除任务只保留「恢复」，并展示删除时间与删除前状态。
 */
export function TaskActionsRow({
  taskEntry,
  activeStatusTab,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onSetLifecycle,
  onRestore
}) {
  const [lifecycleAnchorRect, setLifecycleAnchorRect] = useState(null);
  const isDeletedTask = Boolean(taskEntry.deletedAt);
  const isPublishedTask = taskEntry.lifecycle === '已发布';
  // 「全部」tab 混排所有状态，不参与拖拽排序
  const isReorderEnabled = activeStatusTab !== 'all';
  const stageTagClass = ['stage-tag', taskEntry.lifecycle ? STAGE_CLASS_MAP[taskEntry.lifecycle] || '' : '']
    .filter(Boolean)
    .join(' ');

  if (isDeletedTask) {
    return (
      <tr className="task-actions-row">
        <td colSpan={5}>
          <div className="task-actions-line">
            <span className="detail-line-label">已删除</span>
            <span className="task-deleted-meta">
              删除于 {formatTimestamp(taskEntry.deletedAt)}
              {taskEntry.lifecycleBeforeDelete ? ` · 删除前「${taskEntry.lifecycleBeforeDelete}」` : ''}
            </span>
            <button type="button" className="button-secondary task-action-button" onClick={onRestore}>
              恢复
            </button>
            <span className="task-deleted-hint">彻底删除在右侧「⋯」菜单里（可勾选强制）</span>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="task-actions-row">
      <td colSpan={5}>
        <div className="task-actions-line">
          <span className="detail-line-label">操作</span>
          <span
            className={stageTagClass}
            title="点击切换生命周期"
            onClick={(clickEvent) => {
              setLifecycleAnchorRect(clickEvent.currentTarget.getBoundingClientRect());
            }}
          >
            {taskEntry.lifecycle || '待开发'}
          </span>
          {lifecycleAnchorRect ? (
            <LifecycleMenu
              anchorRect={lifecycleAnchorRect}
              currentLifecycle={taskEntry.lifecycle || '待开发'}
              onSelect={(nextLifecycle) => {
                setLifecycleAnchorRect(null);
                onSetLifecycle(nextLifecycle);
              }}
              onClose={() => setLifecycleAnchorRect(null)}
            />
          ) : null}
          {isReorderEnabled && !isPublishedTask ? (
            <>
              <button
                type="button"
                className="button-secondary task-action-button"
                disabled={!canMoveUp}
                onClick={onMoveUp}
              >
                ↑ 上移
              </button>
              <button
                type="button"
                className="button-secondary task-action-button"
                disabled={!canMoveDown}
                onClick={onMoveDown}
              >
                ↓ 下移
              </button>
            </>
          ) : null}
          <span className="task-lifecycle-hint">点左侧标签切换状态（含已发布）</span>
        </div>
      </td>
    </tr>
  );
}
