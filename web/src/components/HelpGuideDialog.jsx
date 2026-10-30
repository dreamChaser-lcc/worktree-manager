import React, { useEffect, useState } from 'react';
import { helpGuideSections } from '../help/helpGuideContent.js';

/**
 * 使用指南弹窗：左侧目录导航 + 右侧正文区。
 * 复用目录选择器弹层的 overlay / dialog 基础样式，正文按 block.type 分派渲染。
 */
export function HelpGuideDialog({ onClose }) {
  const [activeSectionId, setActiveSectionId] = useState(helpGuideSections[0].id);

  // 支持 Esc 关闭，避免只能用鼠标点右上角
  useEffect(() => {
    function handleKeyDown(keyEvent) {
      if (keyEvent.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const activeSection =
    helpGuideSections.find((guideSection) => guideSection.id === activeSectionId) || helpGuideSections[0];

  function renderGuideBlock(guideBlock, blockIndex) {
    const blockKey = `${activeSection.id}-${blockIndex}`;

    if (guideBlock.type === 'paragraph') {
      return (
        <p key={blockKey} className="help-guide-paragraph">
          {guideBlock.text}
        </p>
      );
    }

    if (guideBlock.type === 'list') {
      return (
        <ul key={blockKey} className="help-guide-list">
          {guideBlock.items.map((itemText, itemIndex) => (
            <li key={`${blockKey}-${itemIndex}`}>{itemText}</li>
          ))}
        </ul>
      );
    }

    if (guideBlock.type === 'command') {
      return (
        <pre key={blockKey} className="help-guide-command">
          {guideBlock.lines.join('\n')}
        </pre>
      );
    }

    if (guideBlock.type === 'warning') {
      return (
        <div key={blockKey} className="alert-warning">
          {guideBlock.text}
        </div>
      );
    }

    if (guideBlock.type === 'table') {
      return (
        <table key={blockKey} className="help-guide-table">
          <thead>
            <tr>
              {guideBlock.columns.map((columnTitle) => (
                <th key={`${blockKey}-${columnTitle}`}>{columnTitle}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {guideBlock.rows.map((rowCells, rowIndex) => (
              <tr key={`${blockKey}-row-${rowIndex}`}>
                {rowCells.map((cellText, cellIndex) => (
                  <td key={`${blockKey}-row-${rowIndex}-${cellIndex}`}>{cellText}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    return null;
  }

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-dialog help-guide-dialog" onClick={(clickEvent) => clickEvent.stopPropagation()}>
        <div className="picker-toolbar">
          <span className="picker-current-path">使用指南（按 Esc 或点击遮罩关闭）</span>
          <button type="button" className="button-secondary" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="help-guide-body">
          <nav className="help-guide-nav">
            {helpGuideSections.map((guideSection) => (
              <button
                key={guideSection.id}
                type="button"
                className={
                  guideSection.id === activeSection.id
                    ? 'help-guide-nav-item help-guide-nav-item-active'
                    : 'help-guide-nav-item'
                }
                onClick={() => setActiveSectionId(guideSection.id)}
              >
                {guideSection.title}
              </button>
            ))}
          </nav>

          <div className="help-guide-content" key={activeSection.id}>
            <h3 className="help-guide-title">{activeSection.title}</h3>
            {activeSection.blocks.map((guideBlock, blockIndex) => renderGuideBlock(guideBlock, blockIndex))}
          </div>
        </div>

        <div className="picker-footer">
          <button type="button" className="button-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
