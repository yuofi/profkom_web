import type { Report, ReportVersion, RichText, Revision } from './contract';
import { idPath, page, request } from './request';
export const reportsApi = {
  list: (params?: object) => page<Report>('/reports', params),
  get: (id: string) => request<Report>('get', `/reports/${idPath(id)}`),
  create: (data: { owner_kind: 'event' | 'subevent'; owner_id: string; kind: 'regular' | 'final'; title: string; content: RichText; file_ids: string[] }) => request<Report>('post', '/reports', data),
  update: (id: string, data: Revision & { title?: string; content?: RichText; file_ids?: string[] }) => request<Report>('patch', `/reports/${idPath(id)}`, data),
  publish: (id: string, data: Revision) => request<Report>('post', `/reports/${idPath(id)}/publish`, data),
  versions: (id: string) => page<ReportVersion>(`/reports/${idPath(id)}/versions`),
  history: (series_id: string, year?: number) => page<Report>('/report-history', { series_id, year }),
};
