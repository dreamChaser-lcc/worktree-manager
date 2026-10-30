import Router from '@koa/router';
import { getJob, listMemoryJobs, subscribeJobLog } from '../jobs/job-runner.js';
import { persistenceManager } from '../storage/persistence-manager.js';
import { NotFoundError } from '../core/errors.js';

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/** 任务状态与 SSE 日志流路由：内存任务为运行态，重启后由持久层补齐历史 */
export function registerTaskRoutes(router) {
  // 任务列表：内存任务 + 持久化历史合并（按创建时间倒序），列表不携带日志体
  router.get('/api/tasks', async (context) => {
    const taskList = [];
    const memoryJobIdSet = new Set();
    for (const memoryJob of listMemoryJobs()) {
      memoryJobIdSet.add(memoryJob.id);
      taskList.push(serializeJobSummary(memoryJob));
    }
    const persistedRecordList = await persistenceManager.listJobRecords();
    for (const jobRecord of persistedRecordList) {
      if (!memoryJobIdSet.has(jobRecord.id)) {
        taskList.push(jobRecord);
      }
    }
    taskList.sort((firstTask, secondTask) => (firstTask.createdAt < secondTask.createdAt ? 1 : -1));
    context.body = { tasks: taskList };
  });

  router.get('/api/tasks/:jobId', async (context) => {
    const jobId = context.params.jobId;
    const memoryJob = getJob(jobId);
    if (memoryJob) {
      context.body = serializeJob(memoryJob);
      return;
    }
    const persistedRecord = await persistenceManager.findJobRecordById(jobId);
    if (!persistedRecord) {
      throw new NotFoundError(`任务不存在: ${jobId}`);
    }
    context.body = { ...persistedRecord, logLines: await persistenceManager.readJobLogLines(jobId) };
  });

  // SSE 日志流：先推历史日志，再推增量，终态后关闭；历史任务推全量后立即落终态关闭（事件格式一致，前端无感知）
  router.get('/api/tasks/:jobId/logs', async (context) => {
    const jobId = context.params.jobId;
    const memoryJob = getJob(jobId);
    const persistedRecord = memoryJob ? null : await persistenceManager.findJobRecordById(jobId);
    if (!memoryJob && !persistedRecord) {
      throw new NotFoundError(`任务不存在: ${jobId}`);
    }

    const logLineList = memoryJob ? memoryJob.logLines : await persistenceManager.readJobLogLines(jobId);
    const jobStatus = memoryJob ? memoryJob.status : persistedRecord.status;
    const jobExitCode = memoryJob ? memoryJob.exitCode : persistedRecord.exitCode;

    context.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    context.status = 200;
    context.respond = false;

    const responseBody = context.res;
    responseBody.write(`event: history\ndata: ${JSON.stringify(logLineList)}\n\n`);

    if (jobStatus !== 'running') {
      responseBody.write(`event: end\ndata: ${JSON.stringify({ status: jobStatus, exitCode: jobExitCode })}\n\n`);
      responseBody.end();
      return;
    }

    const unsubscribeLog = subscribeJobLog(memoryJob, (payload) => {
      if (payload.type === 'append') {
        responseBody.write(`event: append\ndata: ${JSON.stringify(payload.lines)}\n\n`);
      } else {
        responseBody.write(
          `event: end\ndata: ${JSON.stringify({ status: payload.status, exitCode: payload.exitCode })}\n\n`
        );
        responseBody.end();
      }
    });

    const heartbeatHandle = setInterval(() => {
      responseBody.write(': heartbeat\n\n');
    }, SSE_HEARTBEAT_INTERVAL_MS);

    context.req.on('close', () => {
      clearInterval(heartbeatHandle);
      unsubscribeLog();
    });
  });
}

function serializeJobSummary(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    exitCode: job.exitCode,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt
  };
}

function serializeJob(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    exitCode: job.exitCode,
    logLines: job.logLines,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt
  };
}
