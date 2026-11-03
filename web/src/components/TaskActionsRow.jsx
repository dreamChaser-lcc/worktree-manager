import React, { useEffect, useRef, useState } from 'react';

const STAGE_OPTIONS = ['待开发', '开发中', '测试中'];

/** 阶段标签下拉：fixed 定位浮层（不受表格滚动容器裁剪），点击外部关闭 */
function StageTagMenu({ anchorRect, currentStage, onSelect, onClose }) {
  const menuReference = useRef(null);
  const [menuStyle, setMenuStyle] = useState(null);

  useEffect(() => {
    const menuHeight = 120;
    let top = anchorRect.bottom + 2;
    if (top + menuHeight > window.innerHeight - 8) {
      top = anchorRect.top - menuHeight;
    }
    setMenuStyle({
      top: Math.max(8, top),
      left: Math.min(Math.max(8, anchorRect.left), window.innerWidth - 170)
    });
    function handleDocumentMouseDown(mouseEvent) {
      if (menuReference.current) {
        if (!menuReference.current.contains(mouseEvent.target)) {
          onClose();
        }
      }
    }
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={menuReference}
      className="stage-tag-pop"
      style={menuStyle ? menuStyle : { opacity: 0, pointerEvents: 'none' }}
    >
      {STAGE_OPTIONS.map((stageName) => (
        <button
          key={stageName}
          type="button"
          className={
            currentStage === stageName
              ? 'stage-tag-menu-item stage-tag-menu-item-active'
              : 'stage-tag-menu-item'
          }
          onClick={() => onSelect(currentStage === stageName ? null : stageName)}
        >
          {stageName}
        </button>
      ))}
    </div>
  );
}

const STAGE_CLASS_MAP = {
  待开发: 'stage-tag-wait',
  开发中: 'stage-tag-dev',
  测试中: 'stage-tag-test'
};

/**
 * 需求任务的"操作行"：渲染在主行与备注行之间，平铺展示
 * 上移 / 下移 / 标记已发布（或取消发布）/ 阶段标签（点击弹下拉切换）。
 * 阶段标签菜单状态自包含在本组件内，父组件只需传回调。
 */
export function TaskActionsRow({
  taskEntry,
  activeStatusTab,
  canMoveUp,
  canMoveDown,
  publishPending,
  onMoveUp,
  onMoveDown,
  onPublish,
  onUnpublish,
  onSetStage
}) {
  const [stageAnchorRect, setStageAnchorRect] = useState(null);
  const isEditable = !taskEntry.deletedAt;
  const isUnpublishedTab = activeStatusTab === 'unpublished';
  const stageTagClass = ['stage-tag', STAGE_CLASS_MAP[taskEntry.stageTag] ? STAGE_CLASS_MAP[taskEntry.stageTag] : '']
    .filter(Boolean)
    .join(' ');

  return (
    <tr className="task-actions-row">
      <td colSpan={5}>
        <div className="task-actions-line">
          <span className="detail-line-label">操作</span>
          <span
            className={stageTagClass}
            onClick={(clickEvent) => {
              if (!isEditable) {
                return;
              }
              setStageAnchorRect(clickEvent.currentTarget.getBoundingClientRect());
            }}
            title={isEditable ? '点击设置阶段标签' : ''}
          >
            {taskEntry.stageTag ? taskEntry.stageTag : '未设置'}
          </span>
          {stageAnchorRect ? (
            <StageTagMenu
              anchorRect={stageAnchorRect}
              currentStage={taskEntry.stageTag ? taskEntry.stageTag : null}
              onSelect={(nextStageTag) => {
                setStageAnchorRect(null);
                onSetStage(nextStageTag);
              }}
              onClose={() => setStageAnchorRect(null)}
            />
          ) : null}
          {isUnpublishedTab ? (
            isEditable ? (
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
            ) : null
          ) : null}
          {isUnpublishedTab ? (
            isEditable ? (
              <button
                type="button"
                className="button-secondary task-action-button"
                disabled={publishPending}
                onClick={onPublish}
              >
                {publishPending ? '发布中...' : '标记已发布'}
              </button>
            ) : null
          ) : null}
          {isUnpublishedTab ? null : isEditable ? (
            <button
              type="button"
              className="button-secondary task-action-button"
              disabled={publishPending}
              onClick={onUnpublish}
            >
              {publishPending ? '操作中...' : '取消发布'}
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
