import type { Material, RichText, Revision } from './contract';
import { idPath, page, request } from './request';
export const materialsApi = {
  list: () => page<Material>('/materials'),
  get: (id: string) => request<Material>('get', `/materials/${idPath(id)}`),
  create: (data: { kind: string; owner_block_id?: string; title: string; description: string; content: RichText; original_link?: string }) => request<Material>('post', '/materials', data),
  update: (id: string, data: Revision & { title?: string; description?: string; content?: RichText; original_link?: string | null }) => request<Material>('patch', `/materials/${idPath(id)}`, data),
  publish: (id: string, data: Revision) => request<Material>('post', `/materials/${idPath(id)}/publish`, data),
  remove: (id: string) => request<void>('delete', `/materials/${idPath(id)}`),
  editors: (id: string, user_ids: number[], data: Revision) => request<{ material_id: string; editor_user_ids: number[]; revision: number }>('put', `/materials/${idPath(id)}/editors`, { user_ids, ...data }),
};
