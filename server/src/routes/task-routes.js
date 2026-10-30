import Router from '@koa/router';
import { getJob, subscribeJobLog } from '../jobs/job-runner.js';
import { NotFoundError } from '../core/errors.js';

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/** 任务状态与 SSE 日志流路由 */
export function registerTaskRoutes(router) {
  router.get('/api/tasks/:jobId', async (context) => {
    const job = requireJob(context.params.jobId);
    context.body = serializeJob(job);
  });

  // SSE 日志流：先推历史日志，再推增量，终态后关闭
  router.get('/api/tasks/:jobId/logs', async (context) => {
    const job = requireJob(context.params.jobId);

    context.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    context.status = 200;
    context.respond = false;

    const responseBody = context.res;
    responseBody.write(`event: history\ndata: ${JSON.stringify(job.logLines)}\n\n`);

    if (job.status !== 'running') {
      responseBody.write(`event: end\ndata: ${JSON.stringify({ status: job.status, exitCode: job.exitCode })}\n\n`);
      responseBody.end();
      return;
    }

    const unsubscribeLog = subscribeJobLog(job, (payload) => {
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

function requireJob(jobId) {
  const job = getJob(jobId);
  if (!job) {
    throw new NotFoundError(`任务不存在: ${jobId}`);
  }
  return job;
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
