import { useState } from 'react';

/**
 * 按钮级异步动作 pending 状态管理：
 * - isPending(key)：判断某动作是否进行中（按钮据此禁用并显示 spinner）
 * - run(key, runner)：包装执行异步动作，进行中重复调用直接忽略（防连点），结束自动解除
 * key 粒度由调用方约定（如 `restore:${taskId}`、`reveal:${path}`），互不干扰。
 */
export function usePendingActions() {
  const [pendingKeyMap, setPendingKeyMap] = useState({});

  function isPending(actionKey) {
    return Boolean(pendingKeyMap[actionKey]);
  }

  async function run(actionKey, actionRunner) {
    if (pendingKeyMap[actionKey]) {
      return undefined;
    }
    setPendingKeyMap((previousMap) => ({ ...previousMap, [actionKey]: true }));
    try {
      return await actionRunner();
    } finally {
      setPendingKeyMap((previousMap) => {
        const nextMap = { ...previousMap };
        delete nextMap[actionKey];
        return nextMap;
      });
    }
  }

  return { isPending, run };
}
