import { describe, it, expect } from 'vitest';
import { resolveEditorExecutable, buildEditorSpawnCommand } from '../src/core/editor-opener.js';

describe('编辑器可执行文件解析（editor-opener）', () => {
  it('批处理 shim 解析出真实 exe（buddycn 在本机时）', () => {
    const resolved = resolveEditorExecutable('buddycn');
    if (!resolved) {
      expect(resolved).toBeNull();
      return;
    }
    expect(resolved.exe.toLowerCase()).toContain('codebuddy cn.exe');
    expect(resolved.prefixArguments).toEqual([]);
  });

  it('不存在的命令解析返回 null', () => {
    expect(resolveEditorExecutable('definitely-not-a-real-editor-xyz')).toBeNull();
  });

  it('回退引号构建：命令与路径整体加引号', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const { commandText, argumentText } = buildEditorSpawnCommand('D:\\ws\\x.code-workspace', 'buddycn');
    expect(commandText).toBe('"buddycn"');
    expect(argumentText).toBe('"D:\\ws\\x.code-workspace"');
  });
});
