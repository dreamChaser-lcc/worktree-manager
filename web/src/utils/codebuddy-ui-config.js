/**
 * CodeBuddy 页签的刷新配置（存 localStorage，纯前端行为）。
 *
 * 两类轮询是不同东西，分开配置：
 * - overviewPoll：实例状态（运行中/端口/按钮可用性）。关掉后只能靠列表上的「刷新」按钮。
 * - sessionSync：对话内容（终端里写入的内容要不要自动出现）。默认关闭。
 */
const UI_CONFIG_KEY = 'codebuddyUiConfig';
// 旧版本的键，仅用于把用户之前的选择迁移过来
const LEGACY_POLLING_KEY = 'codebuddyPollingConfig';

const DEFAULT_UI_CONFIG = {
  overviewPoll: { enabled: true, intervalMs: 5000 },
  sessionSync: { enabled: false, intervalMs: 5000 }
};

export const OVERVIEW_INTERVAL_OPTION_LIST = [5000, 10000, 30000];
export const SESSION_SYNC_INTERVAL_OPTION_LIST = [3000, 5000, 10000, 30000];

/** 把任意来源的值收敛成合法配置，避免脏数据把定时器设成 0 或负数 */
function normalizePollingEntry(entry, fallbackEntry, allowedIntervalList) {
  const intervalMilliseconds = Number(entry && entry.intervalMs);
  return {
    enabled: entry && typeof entry.enabled === 'boolean' ? entry.enabled : fallbackEntry.enabled,
    intervalMs: allowedIntervalList.includes(intervalMilliseconds) ? intervalMilliseconds : fallbackEntry.intervalMs
  };
}

/** 读配置：优先新键，读不到再看旧键（旧键只管会话同步） */
export function readCodebuddyUiConfig() {
  try {
    const rawConfig = window.localStorage.getItem(UI_CONFIG_KEY);
    if (rawConfig) {
      const parsedConfig = JSON.parse(rawConfig);
      return {
        overviewPoll: normalizePollingEntry(
          parsedConfig.overviewPoll,
          DEFAULT_UI_CONFIG.overviewPoll,
          OVERVIEW_INTERVAL_OPTION_LIST
        ),
        sessionSync: normalizePollingEntry(
          parsedConfig.sessionSync,
          DEFAULT_UI_CONFIG.sessionSync,
          SESSION_SYNC_INTERVAL_OPTION_LIST
        )
      };
    }

    const legacyConfig = window.localStorage.getItem(LEGACY_POLLING_KEY);
    if (legacyConfig) {
      const parsedLegacy = JSON.parse(legacyConfig);
      return {
        overviewPoll: { ...DEFAULT_UI_CONFIG.overviewPoll },
        sessionSync: normalizePollingEntry(
          { enabled: parsedLegacy.enabled === true, intervalMs: parsedLegacy.intervalMs },
          DEFAULT_UI_CONFIG.sessionSync,
          SESSION_SYNC_INTERVAL_OPTION_LIST
        )
      };
    }
  } catch {
    // 解析失败按默认值处理
  }
  return {
    overviewPoll: { ...DEFAULT_UI_CONFIG.overviewPoll },
    sessionSync: { ...DEFAULT_UI_CONFIG.sessionSync }
  };
}

/** 写配置（失败不影响本次会话） */
export function writeCodebuddyUiConfig(uiConfig) {
  try {
    window.localStorage.setItem(UI_CONFIG_KEY, JSON.stringify(uiConfig));
  } catch {
    // 忽略存储异常
  }
}
