import type { Revision, RichText, Task } from "../utils/api/contract";
import { idPath, request } from "../utils/api/request";

/** The site offers neither «Взять в работу» nor «Сдать результат» (owner 2026-11-08, В6), yet the
 *  server keeps POST /tasks/{id}/take and /submit-result: tests that need an earlier result or an
 *  atomic join call them directly. */
export const takeTask = (id: string, data: Revision) => request<Task>("post", `/tasks/${idPath(id)}/take`, data);
export const submitTaskResult = (id: string, data: Revision & { text: RichText; links?: string[]; file_ids?: string[] }) =>
  request<Task>("post", `/tasks/${idPath(id)}/submit-result`, data);
