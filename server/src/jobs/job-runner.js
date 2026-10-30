import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * 内存任务表：管理独立安装等长耗时任务。
 * 服务重启即失效（任务可重跑，无持久化需求，见 design D5）。
 * logListeners 集合供 SSE 端点注册增量推送回调。
 */
const jobMap = new Map();

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
  return job;
}

export function getJob(jobId) {
  return jobMap.get(jobId) || null;
}

/** 追加一行日志并通知 SSE 监听者 */
export function appendJobLog(job, logText) {
  for (const lineText of logText.split(/\r?\n/)) {
    if (lineText === '') {
      continue;
    }
    job.logLines.push(lineText);
    job.logVersion += 1;
    notifyJobListeners(job, { type: 'append', lines: [lineText] });
  }
}

export function finishJob(job, status, exitCode) {
  job.status = status;
  job.exitCode = exitCode;
  job.finishedAt = new Date().toISOString();
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
