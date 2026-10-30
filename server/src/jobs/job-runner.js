import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { persistenceManager } from '../storage/persistence-manager.js';

/**
 * 任务表：内存 Map 为运行时权威，持久化仅作历史留存（add-local-persistence design D4）。
 * 元数据在创建/终态变更时写 nedb，日志按任务追加 JSONL 文件；服务重启后历史可查。
 * logListeners 集合供 SSE 端点注册增量推送回调，属运行时句柄，不落盘。
 * 所有落盘动作内部捕获异常（降级为告警），不阻断任务本身。
 */
const jobMap = new Map();

function toJobRecordSnapshot(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    exitCode: job.exitCode,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt
  };
}

export function createJob(jobName) {
  const job = {
    id: randomUUID(),
    name: jobName,
    status: 'running',
    logLines: [],
    logVersion: 0,
    exitCode: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    logListeners: new Set()
  };
  jobMap.set(job.id, job);
  persistenceManager.insertJobRecord(toJobRecordSnapshot(job));
  return job;
}

export function getJob(jobId) {
  return jobMap.get(jobId) || null;
}

/** 枚举内存任务（任务列表接口合并持久化历史时用） */
export function listMemoryJobs() {
  return Array.from(jobMap.values());
}

/** 追加一行日志并通知 SSE 监听者，同步追加到任务日志文件 */
export function appendJobLog(job, logText) {
  const appendedLineList = [];
  for (const lineText of logText.split(/\r?\n/)) {
    if (lineText === '') {
      continue;
    }
    job.logLines.push(lineText);
    job.logVersion += 1;
    appendedLineList.push(lineText);
    notifyJobListeners(job, { type: 'append', lines: [lineText] });
  }
  if (appendedLineList.length > 0) {
    persistenceManager.appendJobLogLines(job.id, appendedLineList);
  }
}

export function finishJob(job, status, exitCode) {
  job.status = status;
  job.exitCode = exitCode;
  job.finishedAt = new Date().toISOString();
  persistenceManager.updateJobRecord(toJobRecordSnapshot(job));
  notifyJobListeners(job, { type: 'end', status, exitCode });
  job.logListeners.clear();
}

function notifyJobListeners(job, payload) {
  for (const listener of job.logListeners) {
    try {
      listener(payload);
    } catch {
      // 单个监听者异常不影响任务与其它监听者
    }
  }
}

export function subscribeJobLog(job, listener) {
  job.logListeners.add(listener);
  return () => job.logListeners.delete(listener);
}

/**
 * 崩溃恢复（服务启动时调用）：持久层遗留的 running 任务已随上次进程死亡，
 * 批量标记为 interrupted；返回标记条数供启动日志提示。
 */
export async function recoverInterruptedJobs() {
  return persistenceManager.markRunningJobsAsInterrupted(new Date().toISOString());
}

/**
 * 启动一个进程型任务：输出按行进入日志，进程退出即落终态。
 * 返回 job 供调用方立即响应，进度走 SSE。
 */
export function startProcessJob({ jobName, command, commandArguments, cwd }) {
  const job = createJob(jobName);
  appendJobLog(job, `$ ${command} ${commandArguments.join(' ')} (cwd: ${cwd})`);

  const childProcess = spawn(command, commandArguments, {
    cwd,
    windowsHide: true,
    shell: process.platform === 'win32'
  });

  childProcess.stdout.on('data', (chunk) => appendJobLog(job, chunk.toString('utf8')));
  childProcess.stderr.on('data', (chunk) => appendJobLog(job, chunk.toString('utf8')));
  childProcess.on('error', (spawnError) => {
    appendJobLog(job, `[进程启动失败] ${spawnError.message}`);
    finishJob(job, 'failed', null);
  });
  childProcess.on('close', (exitCode) => {
    finishJob(job, exitCode === 0 ? 'success' : 'failed', exitCode);
  });

  return { job, childProcess };
}
