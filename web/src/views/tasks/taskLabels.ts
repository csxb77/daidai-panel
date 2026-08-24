const SUBSCRIPTION_LABEL_PREFIX = 'subscription:'
const SUBSCRIPTION_DISPLAY_LABEL = '订阅任务'
const TASK_GROUP_LABEL_PREFIX = '分组:'

function uniqueLabels(labels: string[]) {
  return Array.from(new Set(labels.filter(Boolean)))
}

export function isInternalTaskLabel(label: string) {
  return label.startsWith(SUBSCRIPTION_LABEL_PREFIX) || label.startsWith(TASK_GROUP_LABEL_PREFIX)
}

/**
 * 任务是否由订阅管理：原始 labels 里带 `subscription:<id>` 前缀。
 *
 * ⚠️ 判定只能用原始 labels，不要换成 subscription_labels：那个字段只有任务列表接口会补，
 * 单条任务接口（含「恢复为订阅默认」的响应）走的是 ToDict()，不带它——
 * 用它判定会让订阅相关的区块在刷新单条数据后突然消失。
 *
 * ⚠️ 这里先 trim 再判前缀，是刻意与后端 hasSubscriptionLabel（server/handler/task_labels.go）对齐，
 * 不是笔误：这一处的判定结果决定详情页「订阅同步」整行渲不渲染，也就是用户还有没有「恢复为订阅默认」
 * 这个解锁入口。历史脏数据里存在 " subscription:1" 这种带前导空格的标签，后端 TrimSpace 后认它是订阅任务、
 * 照常加锁，前端不 trim 就会判成非订阅任务把那一行藏掉——用户看得到「已锁定」却没有任何入口解开，
 * 是不可自愈的死状态，而不是显示瑕疵。
 * 本文件其它函数（isInternalTaskLabel / getTaskGroupName / getDisplayTaskLabels 等）保持不 trim：
 * 它们不决定解锁入口，加 trim 只会改变既有行为，别顺手一起改。
 */
export function isSubscriptionTask(labels: string[] = []) {
  return labels.some(label => typeof label === 'string' && label.trim().startsWith(SUBSCRIPTION_LABEL_PREFIX))
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
