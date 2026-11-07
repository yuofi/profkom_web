// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "./transport";
import { tasksApi } from "../utils/api/tasks.api";
import { filesApi } from "../utils/api/files.api";
import { taskCollaborationApi } from "../utils/api/taskCollaboration.api";
import { richText } from "../utils/api/contract";
import { wireIssues } from "../test/wireContract";
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(() => { mock?.restore();mock = undefined; });
const BODY = "😀 План\n- [ ] Купить бумагу\n- [x] Позвонить";
const offset = (body: string, label: string) => body.indexOf(`] ${label}`) - 1;

it("the demo ticks a comment mark like the server: not an edit, guarded by the body the reader saw", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const task = mock.state.tasks[0], made = await tasksApi.comment(task.task_id, richText(BODY));
  expect(made.capabilities).toEqual(expect.arrayContaining(["edit_comment", "toggle_comment_checklist", "delete_comment"]));
  const ticked = await tasksApi.commentChecklist(made.comment_id, { expected_body: BODY, offset: offset(BODY, "Купить"), checked: true });
  expect(wireIssues("Comment", ticked)).toEqual([]);
  expect(ticked.content.body).toBe(BODY.replace("[ ] Купить", "[x] Купить"));expect(ticked.updated_at).toBeNull();
  // A repeat after a lost answer is accepted; another change since the read is not.
  await expect(tasksApi.commentChecklist(made.comment_id, { expected_body: BODY, offset: offset(BODY, "Купить"), checked: true })).resolves.toMatchObject({ content: { body: ticked.content.body } });
  await expect(tasksApi.commentChecklist(made.comment_id, { expected_body: BODY, offset: offset(BODY, "Позвонить"), checked: false })).rejects.toMatchObject({ status: 409, code: "comment_changed" });
  await expect(tasksApi.commentChecklist(made.comment_id, { expected_body: ticked.content.body, offset: 0, checked: true })).rejects.toMatchObject({ status: 403, code: "checklist_only" });
  const events = (await tasksApi.history(task.task_id)).items;
  expect(events.at(-1)).toMatchObject({ kind: "comment_checklist_toggled", description: "Отмечен пункт «Купить бумагу» в комментарии", changes: [{ field: "comment", before: BODY, after: ticked.content.body }] });
  expect(events.some(event => event.kind === "comment_edited")).toBe(false);
});

it("the demo deletes a comment without a placeholder, withdraws its files and cancels its pending mention", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const state = mock.state, task = state.tasks[0];task.created_by = state.user;
  const file = await filesApi.upload(new File(["bytes"], "comment.pdf", { type: "application/pdf" }), { owner_kind: "task", owner_id: task.task_id, purpose: "comment" });
  const outsider = state.people.find(person => person.user_id !== state.session.user_id)!;
  const made = await tasksApi.comment(task.task_id, richText("Лишний"), [outsider.user_id!], [file.file_id]);
  await expect(filesApi.content(file.file_id)).resolves.toBeInstanceOf(Blob);
  await tasksApi.deleteComment(made.comment_id);
  expect((await tasksApi.comments(task.task_id)).items.some(item => item.comment_id === made.comment_id)).toBe(false);
  await tasksApi.deleteComment(made.comment_id);// a repeat after a lost answer is no error
  await expect(tasksApi.editComment(made.comment_id, richText("Правка"))).rejects.toMatchObject({ status: 404, code: "comment_deleted" });
  await expect(tasksApi.commentChecklist(made.comment_id, { expected_body: "Лишний", offset: 0, checked: true })).rejects.toMatchObject({ status: 404, code: "comment_deleted" });
  await expect(filesApi.content(file.file_id)).rejects.toMatchObject({ status: 404 });
  const requests = (await taskCollaborationApi.mentions(task.task_id)).items.filter(row => row.comment_id === made.comment_id);
  expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({ status: "cancelled", capabilities: [] });expect(wireIssues("TaskMentionRequest", requests[0])).toEqual([]);
  expect((await tasksApi.history(task.task_id)).items.at(-1)).toMatchObject({ kind: "comment_deleted", description: "Комментарий удалён", changes: [{ field: "comment", before: "Лишний", after: null }] });
});
