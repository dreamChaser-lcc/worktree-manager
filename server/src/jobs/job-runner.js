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

export function createJob(jobName, jobMetadata = null) {
  const job = {
    id: randomUUID(),
    name: jobName,
    status: 'running',
    logLines: [],
    logVersion: 0,
    exitCode: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    // 业务元数据（如 kind/worktreePath/taskId），用于运行中任务的互斥判断，不落盘
    metadata: jobMetadata,
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

/** 移除已结束任务的内存条目（任务记录删除用；运行中任务由调用方先行拦截） */
export function removeMemoryJob(jobId) {
  return jobMap.delete(jobId);
}

/**
 * 按条件查找运行中的任务（互斥锁等场景用）。
 * 运行态权威在内存 jobMap，服务重启后 running 任务已被标记 interrupted，无需查持久层。
 */
export function findRunningJob(matchPredicate) {
  for (const job of jobMap.values()) {
    if (job.status === 'running' && matchPredicate(job)) {
      return job;
    }
  }
  return null;
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
export function startProcessJob({ jobName, command, commandArguments, cwd, metadata, useShell }) {
  const job = createJob(jobName, metadata || null);
  appendJobLog(job, `$ ${command} ${commandArguments.join(' ')} (cwd: ${cwd})`);

  const childProcess = spawn(command, commandArguments, {
    cwd,
    windowsHide: true,
    // 默认维持原行为：Windows 走 shell（路径/命令解析一致）；useShell 可显式覆盖（自定义脚本必须走 shell）
    shell: useShell !== undefined ? useShell : process.platform === 'win32'
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
