import type { Page, Revision, UserRef, TaskMentionRequest } from './contract';
export type {TaskMentionRequest} from './contract';
import { idPath, request } from './request';
export const taskCollaborationApi={
  candidates:(id:string)=>request<Page<UserRef>>('get',`/tasks/${idPath(id)}/mention-candidates`),
  mentions:(id:string)=>request<Page<TaskMentionRequest>>('get',`/tasks/${idPath(id)}/mentions`),
  decide:(id:string,requestId:string,approve:boolean,data:Revision)=>request<TaskMentionRequest>('post',`/tasks/${idPath(id)}/mentions/${idPath(requestId)}/${approve?'approve':'reject'}`,data),
  revoke:(id:string,userId:number)=>request<{revoked:boolean}>('post',`/tasks/${idPath(id)}/access/${idPath(userId)}/revoke`),
};
