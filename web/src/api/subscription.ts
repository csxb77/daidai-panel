import request from './request'

// 订阅创建/更新的请求体。
//
// 本文件其余接口历史上一直用 `any`：订阅表单是把整个 editForm 展开提交的，字段多、
// 且会随表单增删而变。这里刻意只把**需要前后端逐字对齐的字段**单独声明出来，
// 其余仍原样透传，避免再维护一份注定滞后于表单的全量字段表。
export type SubscriptionPayload = Record<string, any> & {
  // 完整检出（v3.2.0 新增，对应 #110）：
  //   true  = 跳过 sparse-checkout，把整个仓库拉下来（体积可能很大）
  //   缺省 / false = 维持按「指定子目录 / 白名单 / 依赖规则」裁剪的稀疏检出
  // 默认必须是 false，存量订阅升级后行为才不变。
  // 字段名与后端 model.Subscription 的 json tag 逐字一致，改名要两边一起改。
  full_checkout?: boolean
}

export const subscriptionApi = {
  list(params?: { keyword?: string; type?: string; enabled?: boolean; page?: number; page_size?: number }) {
    return request.get('/subscriptions', { params }) as Promise<{ data: any[]; total: number; page: number; page_size: number }>
  },

  create(data: SubscriptionPayload) {
    return request.post('/subscriptions', data) as Promise<{ message: string; data: any }>
  },

  update(id: number, data: SubscriptionPayload) {
    return request.put(`/subscriptions/${id}`, data) as Promise<{ message: string; data: any }>
  },

  delete(id: number) {
    return request.delete(`/subscriptions/${id}`) as Promise<{ message: string }>
  },

  enable(id: number) {
    return request.put(`/subscriptions/${id}/enable`) as Promise<{ message: string; data: any }>
  },

  disable(id: number) {
    return request.put(`/subscriptions/${id}/disable`) as Promise<{ message: string; data: any }>
  },

  pull(id: number) {
    return request.put(`/subscriptions/${id}/pull`) as Promise<{ message: string }>
  },

  stopPull(id: number) {
    return request.put(`/subscriptions/${id}/pull/stop`) as Promise<{ message: string }>
  },

  logs(id: number, params?: { page?: number; page_size?: number }) {
    return request.get(`/subscriptions/${id}/logs`, { params }) as Promise<{ data: any[]; total: number; page: number; page_size: number }>
  },

  batchDelete(ids: number[]) {
    return request.delete('/subscriptions/batch', { data: { ids } }) as Promise<{ message: string }>
  }
}
