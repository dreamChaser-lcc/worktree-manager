#!/usr/bin/env node
/**
 * 创建需求任务的命令行封装（零依赖，Node 18+）。
 *
 * 相比手写 curl：嵌套的 projectList 由脚本组装，Windows 路径不需要转义，
 * 并且带完整参数校验（类型 / 枚举 / git 分支命名规则 / 路径存在性 / 仓库合法性）。
 *
 * 用法：
 *   node create-requirement.mjs --name "需求标题" --branch "lifachao/1103_xxx" --repo "D:\project\userlive"
 *   node create-requirement.mjs ... --check        只校验参数，不创建（推荐先跑这个）
 *   node create-requirement.mjs ... --check --json 校验结果以 JSON 输出
 *
 * 可选参数：
 *   --url <需求链接>               需求链接
 *   --strategy install|share|skip  依赖策略，默认 install
 *   --stage 待开发|开发中|测试中     阶段标签
 *   --no-workspace                 不生成 .code-workspace
 *   --allow-duplicate              跳过同名同分支查重
 *   --api <地址>                   平台地址，默认 http://127.0.0.1:5210
 *   --json                         结果以 JSON 输出
 *
 * 参数约束详见 ../schemas/create-requirement.schema.json
 */

import { existsSync, statSync } from 'node:fs';

const argumentList = process.argv.slice(2);

const STRATEGY_VALUE_LIST = ['install', 'share', 'skip'];
const STAGE_VALUE_LIST = ['待开发', '开发中', '测试中'];

const flagSet = new Set(argumentList.filter((argumentItem) => argumentItem.startsWith('--')));

function readOption(optionName) {
  const optionIndex = argumentList.indexOf(optionName);
  if (optionIndex === -1) {
    return undefined;
  }
  const optionValue = argumentList[optionIndex + 1];
  // 下一个仍是 -- 开头说明漏了值
  if (!optionValue || optionValue.startsWith('--')) {
    return undefined;
  }
  return optionValue;
}

function readOptionList(optionName) {
  const valueList = [];
  argumentList.forEach((argumentItem, argumentIndex) => {
    if (argumentItem === optionName) {
      const optionValue = argumentList[argumentIndex + 1];
      if (optionValue && !optionValue.startsWith('--')) {
        valueList.push(optionValue);
      }
    }
  });
  return valueList;
}

const rawArgumentMap = {
  name: readOption('--name'),
  branch: readOption('--branch'),
  url: readOption('--url'),
  strategy: readOption('--strategy'),
  stage: readOption('--stage'),
  api: readOption('--api') || process.env.WORKTREE_MANAGER_API || 'http://127.0.0.1:5210'
};
const repoPathList = readOptionList('--repo');
const checkOnly = flagSet.has('--check');
const jsonOutput = flagSet.has('--json');
const generateWorkspace = !flagSet.has('--no-workspace');
const allowDuplicate = flagSet.has('--allow-duplicate');

/** git 分支命名规则校验（简化版 check-ref-format） */
function validateBranchName(branchNameText) {
  const errorMessageList = [];
  if (!branchNameText) {
    return ['必填'];
  }
  if (branchNameText.length > 200) {
    errorMessageList.push('长度不能超过 200');
  }
  if (/\s/.test(branchNameText)) {
    errorMessageList.push('不能包含空格');
  }
  if (/[~^:?*[\\]/.test(branchNameText)) {
    errorMessageList.push('不能包含 ~ ^ : ? * [ \\ 等特殊字符');
  }
  if (branchNameText.includes('..')) {
    errorMessageList.push('不能包含连续两个点 ..');
  }
  if (branchNameText.includes('//')) {
    errorMessageList.push('不能包含连续两个斜杠 //');
  }
  if (/^[/.]/.test(branchNameText)) {
    errorMessageList.push('不能以 / 或 . 开头');
  }
  if (/[/.]$/.test(branchNameText)) {
    errorMessageList.push('不能以 / 或 . 结尾');
  }
  if (/\.lock$/.test(branchNameText)) {
    errorMessageList.push('不能以 .lock 结尾');
  }
  return errorMessageList;
}

/** 本地校验：纯离线，不依赖平台 */
function validateLocalArguments() {
  const errorList = [];

  const requirementName = rawArgumentMap.name;
  if (!requirementName) {
    errorList.push({ field: 'name', message: '必填：需求标题' });
  } else if (requirementName.length > 200) {
    errorList.push({ field: 'name', message: '长度不能超过 200' });
  }

  const branchErrorList = validateBranchName(rawArgumentMap.branch);
  branchErrorList.forEach((branchErrorMessage) => {
    errorList.push({
      field: 'branch',
      message: branchErrorMessage === '必填' ? '必填：开发分支名（须由用户提供，不得编造）' : branchErrorMessage
    });
  });

  if (repoPathList.length === 0) {
    errorList.push({ field: 'repo', message: '至少需要一个 --repo 主仓库绝对路径' });
  }
  repoPathList.forEach((repoPathText, repoIndex) => {
    const trimmedPath = repoPathText.trim();
    if (!/^([A-Za-z]:[\\/]|\\\\)/.test(trimmedPath)) {
      errorList.push({
        field: `repo[${repoIndex}]`,
        message: `必须是绝对路径（盘符或 UNC）：${repoPathText}`
      });
      return;
    }
    if (!existsSync(trimmedPath)) {
      errorList.push({ field: `repo[${repoIndex}]`, message: `目录不存在：${trimmedPath}` });
      return;
    }
    if (!statSync(trimmedPath).isDirectory()) {
      errorList.push({ field: `repo[${repoIndex}]`, message: `不是目录：${trimmedPath}` });
    }
  });

  if (rawArgumentMap.strategy && !STRATEGY_VALUE_LIST.includes(rawArgumentMap.strategy)) {
    errorList.push({
      field: 'strategy',
      message: `取值必须是 ${STRATEGY_VALUE_LIST.join(' / ')}，当前：${rawArgumentMap.strategy}`
    });
  }

  if (rawArgumentMap.stage && !STAGE_VALUE_LIST.includes(rawArgumentMap.stage)) {
    errorList.push({
      field: 'stage',
      message: `取值必须是 ${STAGE_VALUE_LIST.join(' / ')}，当前：${rawArgumentMap.stage}`
    });
  }

  if (rawArgumentMap.url && !/^https?:\/\//.test(rawArgumentMap.url)) {
    errorList.push({ field: 'url', message: `必须是 http(s) 链接，当前：${rawArgumentMap.url}` });
  }

  if (!/^https?:\/\//.test(rawArgumentMap.api)) {
    errorList.push({ field: 'api', message: `必须是 http(s) 地址，当前：${rawArgumentMap.api}` });
  }

  return errorList;
}

const apiBaseUrl = rawArgumentMap.api.replace(/\/+$/, '');

async function callApi(method, requestPath, requestBody) {
  const response = await fetch(`${apiBaseUrl}${requestPath}`, {
    method,
    headers: requestBody ? { 'Content-Type': 'application/json' } : undefined,
    body: requestBody ? JSON.stringify(requestBody) : undefined,
    signal: AbortSignal.timeout(120000)
  });
  const responseText = await response.text();
  let responseBody = null;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseBody = { rawText: responseText };
  }
  if (!response.ok) {
    const messageText =
      (responseBody && (responseBody.message || responseBody.error)) || responseText || `HTTP ${response.status}`;
    throw new Error(`接口失败（${response.status}）：${messageText}`);
  }
  return responseBody;
}

/** 远程校验：确认平台可达 + 每个 repo 确实是 git 仓库 */
async function validateRemoteArguments() {
  const errorList = [];
  try {
    await callApi('GET', '/api/health');
  } catch (healthError) {
    return [
      {
        field: 'api',
        message: `平台不可达（${apiBaseUrl}）。请先双击项目根目录的 start.bat。原始错误：${healthError.message}`
      }
    ];
  }

  for (let repoIndex = 0; repoIndex < repoPathList.length; repoIndex += 1) {
    const repoPathText = repoPathList[repoIndex].trim();
    try {
      const checkResult = await callApi(
        'GET',
        `/api/filesystem/repository-check?path=${encodeURIComponent(repoPathText)}`
      );
      if (!checkResult.isGitRepository) {
        errorList.push({ field: `repo[${repoIndex}]`, message: `不是 git 仓库：${repoPathText}` });
      }
    } catch (checkError) {
      errorList.push({ field: `repo[${repoIndex}]`, message: `仓库校验失败：${checkError.message}` });
    }
  }
  return errorList;
}

function printValidationResult(validFlag, errorList) {
  if (jsonOutput) {
    console.log(JSON.stringify({ valid: validFlag, errors: errorList }, null, 2));
    return;
  }
  if (validFlag) {
    console.log('参数校验通过。');
    console.log(`  需求：${rawArgumentMap.name}`);
    console.log(`  分支：${rawArgumentMap.branch}`);
    console.log(`  项目：${repoPathList.map((repoPathText) => repoPathText.trim()).join('、')}`);
    console.log(`  依赖策略：${rawArgumentMap.strategy || 'install'}`);
    return;
  }
  console.error('参数校验未通过：');
  errorList.forEach((errorItem) => {
    console.error(`  - ${errorItem.field}：${errorItem.message}`);
  });
  console.error('\n以上问题修正后重试；不确定的参数先问用户，不要自行编造。');
}

function buildProjectList() {
  return repoPathList.map((repoPathText) => ({ repoPath: repoPathText.trim() }));
}

async function runCheck() {
  const localErrorList = validateLocalArguments();
  if (localErrorList.length > 0) {
    printValidationResult(false, localErrorList);
    process.exit(1);
  }

  const remoteErrorList = await validateRemoteArguments();
  if (remoteErrorList.length > 0) {
    printValidationResult(false, remoteErrorList);
    process.exit(1);
  }

  printValidationResult(true, []);
}

async function runCreate() {
  if (!allowDuplicate) {
    const existingData = await callApi('GET', '/api/requirement-tasks?status=all&page=1&pageSize=500');
    const existingTask = (existingData.tasks || []).find(
      (taskEntry) =>
        taskEntry.requirementName === rawArgumentMap.name && taskEntry.branchName === rawArgumentMap.branch
    );
    if (existingTask) {
      if (jsonOutput) {
        console.log(
          JSON.stringify({ created: false, reused: true, task: existingTask }, null, 2)
        );
        return;
      }
      console.log('已存在同名同分支的需求任务，未重复创建：');
      console.log(`  taskId：${existingTask.id}`);
      console.log(`  工作区文件：${existingTask.workspaceFilePath || '(未生成)'}`);
      console.log('如需强制新建，追加 --allow-duplicate');
      return;
    }
  }

  const createResult = await callApi('POST', '/api/requirement-tasks', {
    requirementName: rawArgumentMap.name,
    requirementUrl: rawArgumentMap.url,
    branchName: rawArgumentMap.branch,
    projectList: buildProjectList(),
    dependencyStrategy: rawArgumentMap.strategy || 'install',
    generateWorkspace
  });

  const createdTask = createResult.task || {};

  if (rawArgumentMap.stage) {
    try {
      await callApi('POST', `/api/requirement-tasks/${createdTask.id}/stage`, {
        stageTag: rawArgumentMap.stage
      });
      createdTask.stageTag = rawArgumentMap.stage;
    } catch (stageError) {
      console.error(`阶段标签设置失败：${stageError.message}`);
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ created: true, task: createdTask, warning: createResult.warning }, null, 2));
    return;
  }

  console.log('已创建需求任务：');
  console.log(`  taskId：${createdTask.id}`);
  console.log(`  需求：${createdTask.requirementName}`);
  console.log(`  分支：${createdTask.branchName}`);
  console.log(`  工作区文件：${createdTask.workspaceFilePath || '(未生成)'}`);
  if (createdTask.stageTag) {
    console.log(`  阶段标签：${createdTask.stageTag}`);
  }
  console.log('  涉及项目：');
  (createdTask.projectList || []).forEach((projectEntry) => {
    console.log(`    - ${projectEntry.projectName}：${projectEntry.worktreePath || '（未关联 worktree）'}`);
  });
  if (createResult.warning) {
    console.log(`\n注意：${createResult.warning}`);
  }
  console.log('\n依赖安装（install 策略）在后台执行，可在平台「任务记录」查看进度。');
}

async function main() {
  if (checkOnly) {
    await runCheck();
    return;
  }

  // 创建前先做本地校验，避免把明显错误的参数发到平台
  const localErrorList = validateLocalArguments();
  if (localErrorList.length > 0) {
    printValidationResult(false, localErrorList);
    process.exit(1);
  }

  await runCreate();
}

main().catch((mainError) => {
  if (jsonOutput) {
    console.log(JSON.stringify({ valid: false, errors: [{ field: 'runtime', message: mainError.message }] }));
  } else {
    console.error(mainError.message);
  }
  process.exit(1);
});
