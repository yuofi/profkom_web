import axios from 'axios';
import { api } from './index';
import type { Page, SeasonBlocker } from './contract';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, unknown>;
  constructor(message: string, status = 0, code = 'network_error', fields: Record<string, unknown> = {}) {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.fields = fields;
  }
  get blockers(): SeasonBlocker[] { return Array.isArray(this.fields.blockers) ? this.fields.blockers as SeasonBlocker[] : []; }
}
export function normalizeApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? 0;
    const detail: unknown = error.response?.data?.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const d = detail as Record<string, unknown>;
      return new ApiError(typeof d.message === 'string' ? d.message : 'Не удалось выполнить действие', status,
        typeof d.code === 'string' ? d.code : `http_${status}`,
        d.fields && typeof d.fields === 'object' ? d.fields as Record<string, unknown> : {});
    }
    if (Array.isArray(detail)) return new ApiError('Проверьте заполнение полей', status, 'validation_error', { errors: detail });
    return new ApiError(typeof detail === 'string' ? detail : status ? 'Не удалось выполнить запрос' : 'Нет связи с сервером', status, `http_${status}`);
  }
  return new ApiError(error instanceof Error ? error.message : 'Неизвестная ошибка');
}
export async function request<T>(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, data?: unknown, params?: object): Promise<T> {
  try { return (await api.request<T>({ method, url, data, params })).data; }
  catch (error) { throw normalizeApiError(error); }
}
export async function page<T>(url: string, params?: object): Promise<Page<T>> {
  const result = await request<Page<T>>('get', url, undefined, params);
  if (!result || !Array.isArray(result.items) || !(result.next_cursor === null || typeof result.next_cursor === 'string')) {
    throw new ApiError('Ответ сервера не соответствует контракту списка', 0, 'contract_mismatch');
  }
  return result;
}
export const idPath = (id: string | number) => encodeURIComponent(id);
