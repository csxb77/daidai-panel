const SUBSCRIPTION_LABEL_PREFIX = 'subscription:'
const SUBSCRIPTION_DISPLAY_LABEL = '订阅任务'
const TASK_GROUP_LABEL_PREFIX = '分组:'

function uniqueLabels(labels: string[]) {
  return Array.from(new Set(labels.filter(Boolean)))
}

export function isInternalTaskLabel(label: string) {
  return label.startsWith(SUBSCRIPTION_LABEL_PREFIX) || label.startsWith(TASK_GROUP_LABEL_PREFIX)
}

export function getTaskGroupName(labels: string[] = []) {
  for (const label of labels) {
    if (!label) continue
    if (label.startsWith(TASK_GROUP_LABEL_PREFIX)) {
      const group = label.slice(TASK_GROUP_LABEL_PREFIX.length).trim()
      if (group) return group
    }
  }
  return ''
}

export function toTaskGroupLabel(groupName: string) {
  const normalized = groupName.trim()
  return normalized ? `${TASK_GROUP_LABEL_PREFIX}${normalized}` : ''
}

export function getDisplayTaskLabels(labels: string[] = []) {
  const displayLabels: string[] = []
  let hasSubscriptionLabel = false
  const groupName = getTaskGroupName(labels)

  for (const label of labels) {
    if (!label) continue
    if (label.startsWith(SUBSCRIPTION_LABEL_PREFIX)) {
      hasSubscriptionLabel = true
      continue
    }
    if (label.startsWith(TASK_GROUP_LABEL_PREFIX)) {
      continue
    }
    displayLabels.push(label)
  }

  if (groupName) {
    displayLabels.unshift(groupName)
  }

  if (hasSubscriptionLabel) {
    displayLabels.push(SUBSCRIPTION_DISPLAY_LABEL)
  }

  return uniqueLabels(displayLabels)
}

/**
 * 把后端下发的 display_labels 切成「分组 / 订阅 / 自定义」三组，供列表页的标签分项隐藏使用。
 *
 * display_labels 是一个扁平字符串数组，三类标签共用同一个 `.task-label` 样式类、自身不带任何标记，
 * 前端只能靠两条外部证据反推：
 *   1) 分组：原始 labels 里那一项仍带 `分组:` 前缀，用 getTaskGroupName 取出显示名再精确比对。
 *      后端会把它 unshift 到 display_labels[0]，但这里【不按下标 0 猜】——
 *      任务没有分组时第 0 项就是普通自定义标签，按位置判会误伤。
 *   2) 订阅：后端新增的只读字段 subscription_labels（含订阅源已删除时的字面量「订阅任务」）。
 *
 * ⚠️ subscription_labels 是后加的字段，老后端 / 未同步的演示站不会下发。
 * 这里对「缺失或不是数组」一律降级成空集合：订阅标签会被归进 custom 一组，
 * 表现为「关掉订阅标签开关时订阅名没被藏掉」，但界面照常渲染、不报错——宁可少隐藏也不能崩。
 */
export function classifyDisplayTaskLabels(
  displayLabels: string[] = [],
  rawLabels: string[] = [],
  subscriptionLabels?: unknown,
) {
  const groupName = getTaskGroupName(rawLabels)
  const subscriptionSet = new Set(
    Array.isArray(subscriptionLabels)
      ? subscriptionLabels.filter((item): item is string => typeof item === 'string' && !!item)
      : [],
  )

  const group: string[] = []
  const subscription: string[] = []
  const custom: string[] = []

  for (const label of displayLabels) {
    if (!label) continue
    if (groupName && label === groupName) {
      group.push(label)
      continue
    }
    if (subscriptionSet.has(label)) {
      subscription.push(label)
      continue
    }
    custom.push(label)
  }

  return { group, subscription, custom }
}

export function splitTaskLabels(labels: string[] = []) {
  const editableLabels: string[] = []
  const internalLabels: string[] = []
  const groupName = getTaskGroupName(labels)

  for (const label of labels) {
    if (!label) continue
    if (isInternalTaskLabel(label)) {
      internalLabels.push(label)
      continue
    }
    editableLabels.push(label)
  }

  return {
    editableLabels: uniqueLabels(editableLabels),
    internalLabels: uniqueLabels(internalLabels),
    groupName,
  }
}

export function mergeTaskLabels(editableLabels: string[] = [], internalLabels: string[] = [], groupName = '') {
  const merged = [...editableLabels, ...internalLabels.filter(label => !label.startsWith(TASK_GROUP_LABEL_PREFIX))]
  const groupLabel = toTaskGroupLabel(groupName)
  if (groupLabel) merged.push(groupLabel)
  return uniqueLabels(merged)
}
