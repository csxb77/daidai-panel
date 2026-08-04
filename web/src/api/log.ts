import request from './request'
import type { RawLogDownloadTicket } from '@/utils/rawLogDownload'

export const logApi = {
  list(params?: { task_id?: number; status?: number; keyword?: string; page?: number; page_size?: number }) {
    return request.get('/logs', { params }) as Promise<{ data: any[]; total: number; page: number; page_size: number }>
  },

  detail(id: number) {
    return request.get(`/logs/${id}`) as Promise<any>
  },

  // 换取「下载原始日志」的短期票据。真正的文件由浏览器原生下载去拉，不走 axios。
  rawDownloadTicket(id: number) {
    return request.get(`/logs/${id}/raw-ticket`) as Promise<RawLogDownloadTicket>
  },

  delete(id: number) {
    return request.delete(`/logs/${id}`) as Promise<{ message: string }>
  },

  batchDelete(ids: number[]) {
    return request.post('/logs/batch-delete', { ids }) as Promise<{ message: string }>
  },

  clean(days?: number) {
    return request.delete('/logs/clean', { params: { days } }) as Promise<{ message: string }>
  }
}
