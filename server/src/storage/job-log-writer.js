import fs from 'node:fs/promises';

/**
 * 任务日志 JSONL 文件读写。
 * 每个任务一个 <jobId>.jsonl，按行追加（fs.appendFile）。
 * 写入经每任务串行队列排序，避免并发 append 乱序；失败仅告警不抛出（落盘失败不阻断任务）。
 */
export function createJobLogFileWriter(logFilePath) {
  let writeQueue = Promise.resolve();

  return {
    appendLines(lineTextList) {
      if (!lineTextList || lineTextList.length === 0) {
        return;
      }
      const payloadText = `${lineTextList.join('\n')}\n`;
      writeQueue = writeQueue
        .then(() => fs.appendFile(logFilePath, payloadText, 'utf8'))
        .catch((appendError) => {
          console.warn(`[storage] 任务日志写入失败(${logFilePath}): ${appendError.message}`);
        });
    }
  };
}

/** 读取任务完整日志；文件不存在返回空数组（历史任务刚建或从未写日志） */
export async function readJobLogFile(logFilePath) {
  let rawText = '';
  try {
    rawText = await fs.readFile(logFilePath, 'utf8');
  } catch {
    return [];
  }
  if (rawText.length === 0) {
    return [];
  }
  return rawText.replace(/\n$/, '').split('\n');
}
