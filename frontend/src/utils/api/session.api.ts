import type { Leadership, Revision, Session } from './contract';
import { request } from './request';
export const sessionApi = {
  get: () => request<Session>('get', '/session'),
  leadership: () => request<Leadership>('get', '/leadership'),
  transfer: (new_chair_user_id: number, version: Revision) => request<Leadership>('post', '/leadership/transfer', { new_chair_user_id, ...version }),
  deputies: (user_ids: number[], version: Revision) => request<Leadership>('put', '/leadership/deputies', { user_ids, ...version }),
};
