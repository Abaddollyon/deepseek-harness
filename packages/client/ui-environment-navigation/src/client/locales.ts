/** Simplified Chinese environment navigation copy. */
export const zh = {
  'activity': '活动',
  'workspaces': '工作区',
  'environments': '环境',
  'overview.title': '环境',
  'overview.description': '选择主机以浏览其工作区、会话和功能。',
  'overview.local': '本机',
} satisfies Record<string, string>

/** Environment navigation locale key union. */
export type EnvironmentNavigationKey = keyof typeof zh

/** English environment navigation copy. */
export const en = {
  'activity': 'Activity',
  'workspaces': 'Workspaces',
  'environments': 'Environments',
  'overview.title': 'Environments',
  'overview.description': 'Choose a host to browse its workspaces, sessions, and features.',
  'overview.local': 'Local',
} satisfies Record<EnvironmentNavigationKey, string>
