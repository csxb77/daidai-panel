import request from './request'

export interface BackupSelection {
  configs: boolean
  tasks: boolean
  subscriptions: boolean
  env_vars: boolean
  logs: boolean
  scripts: boolean
  dependencies: boolean
  task_views: boolean
}

export interface RestoreProgressState {
  active: boolean
  status: 'idle' | 'running' | 'completed' | 'failed'
  filename?: string
  source?: string
  selection?: Partial<BackupSelection>
  stage?: string
  message?: string
  percent: number
  error?: string
  started_at?: string
  updated_at?: string
}

export interface PanelUpdateStatus {
  status?: 'idle' | 'running' | 'restarting' | 'completed' | 'failed'
  phase?: string
  message?: string
  error?: string
  started_at?: string
  updated_at?: string
  deployment_type?: 'docker' | 'binary' | 'magisk'
  container_name?: string
  image_name?: string
  pull_image_name?: string
  mirror_host?: string
  registry_url?: string
  release_version?: string
  asset_name?: string
  asset_url?: string
  install_dir?: string
  binary_name?: string
  update_manager?: 'panel' | 'watchtower'
  watchtower_response?: Record<string, any>
}

export interface SystemHealthItem {
  name: string
  status: string
  message?: string
}

export interface SystemHealthSnapshot {
  items: SystemHealthItem[]
  last_checked_at?: string
}

export interface ConfigScriptPayload {
  content: string
  path: string
}

export const systemApi = {
  info: () => request.get('/system/info'),
  machineCode: () => request.get('/system/machine-code'),
  dashboard: (range?: number) => request.get('/system/dashboard', { params: range ? { range } : undefined }),
  stats: () => request.get('/system/stats'),
  version: () => request.get('/system/version'),
  publicVersion: () => request.get('/system/public-version'),
  panelSettings: () => request.get('/system/panel-settings'),
  checkUpdate: () => request.get('/system/check-update'),
  updateStatus: () => request.get('/system/update-status'),
  updatePanel: () => request.post('/system/update'),
  restart: () => request.post('/system/restart'),
  panelLog: (params?: { lines?: number; keyword?: string; level?: 'debug' | 'info' | 'warn' | 'error' | '' }) =>
    request.get('/system/panel-log', { params }),
  backup: (password?: string, selection?: Partial<BackupSelection>, name?: string) => request.post('/system/backup', { password, selection, name }),
  backupList: () => request.get('/system/backups'),
  downloadBackup: (filename: string) =>
    request.get('/system/backup/download', {
      params: { filename },
      responseType: 'blob',
    }) as Promise<Blob>,
  restoreProgress: () => request.get('/system/restore/progress'),
  restore: (filename: string, password?: string) =>
    request.post('/system/restore', { filename, password }, { timeout: 0 }),
  deleteBackup: (filename: string) =>
    request.delete('/system/backup', { params: { filename } }),
  healthStatus: () => request.get('/system/health-check') as Promise<SystemHealthSnapshot>,
  healthCheck: () => request.post('/system/health-check') as Promise<SystemHealthSnapshot>,
  uploadBackup: (file: File, onProgress?: (percent: number) => void) => {
    const formData = new FormData()
    formData.append('file', file)
    return request.post('/system/backup/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 0,
      onUploadProgress: onProgress
        ? (e: any) => { if (e.total) onProgress(Math.round((e.loaded * 100) / e.total)) }
        : undefined,
    })
  },
}

export const configScriptApi = {
  get: () => request.get('/system/config-script') as Promise<ConfigScriptPayload>,
  save: (content: string) => request.put('/system/config-script', { content }) as Promise<{ message: string }>,
}

// ============================================================================
// 系统配置 schema
//
// 下面这几个类型与服务端 server/handler/config.go 的 buildConfigResponseItem
// 一一对应，是 GET /api/configs 的真实响应形状；字段真源在
// server/model/system_config_registry.go（47 项）。
//
// 这份 schema 由服务端持有唯一真源，Web 只负责渲染。
// 不做版本兼容降级：Web 与服务端永远同版本发布 —— release 产物里 web/ 目录和
// 二进制来自同一次构建，Docker 镜像同理，面板自更新脚本也是整个 web/ 目录替换。
// 不存在「新 Web + 老服务端」的组合。
// ============================================================================

/** 服务端 SystemConfigValueType 的四个取值 */
export type SystemConfigValueType = 'string' | 'int' | 'bool' | 'enum'

export interface SystemConfigOption {
  value: string
  label: string
}

export interface SystemConfigItemResponse {
  /** 当前值。服务端在库里没记录或记录为空串时已经替换成 default_value */
  value?: string
  /** 长句说明（个别项有三行），只能当 hint，不能当输入框标题 */
  description?: string
  updated_at?: string | null
  /** false 表示这是面板运行时自己写的临时状态，没有 schema，不要渲染也不要回写 */
  registered?: boolean
  default_value?: string
  value_type?: SystemConfigValueType
  group?: string
  /** group 这个英文 slug 对应的中文分组名 */
  group_label?: string
  /** 输入框标题用的短词 */
  label?: string
  /** 注册顺序。本接口返回的是 map 本身没有顺序，客户端要按声明顺序渲染只能靠它 */
  order?: number
  /** 凭据类配置，渲染时应当用密码框（服务端仍然明文下发） */
  secret?: boolean
  /** 只有 int 类型有值，供前端做范围校验（服务端仍会独立校验一次） */
  min?: number
  max?: number
  options?: SystemConfigOption[]
}

export type SystemConfigMap = Record<string, SystemConfigItemResponse>

export const configApi = {
  list: () => request.get('/configs') as Promise<{ data: SystemConfigMap }>,
  get: (key: string) => request.get(`/configs/${key}`),
  set: (data: { key: string; value: string; description?: string }) => request.post('/configs', data),
  batchSet: (configs: Record<string, string>) => request.put('/configs/batch', { configs }),
  delete: (key: string) => request.delete(`/configs/${key}`),
}

export const platformTokenApi = {
  platforms: () => request.get('/platform-tokens/platforms'),
  createPlatform: (data: { name: string; label?: string; icon?: string }) =>
    request.post('/platform-tokens/platforms', data),
  deletePlatform: (id: number) => request.delete(`/platform-tokens/platforms/${id}`),
  list: (platformId?: number) =>
    request.get('/platform-tokens', { params: platformId ? { platform_id: platformId } : {} }),
  create: (data: { platform_id: number; name: string; token: string; remarks?: string }) =>
    request.post('/platform-tokens', data),
  update: (id: number, data: { name?: string; token?: string; remarks?: string }) =>
    request.put(`/platform-tokens/${id}`, data),
  delete: (id: number) => request.delete(`/platform-tokens/${id}`),
  enable: (id: number) => request.put(`/platform-tokens/${id}/enable`),
  disable: (id: number) => request.put(`/platform-tokens/${id}/disable`),
}
