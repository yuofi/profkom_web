// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, settle, submit, waitForPage } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import type { Task, TaskLink, TaskType } from "../../utils/api/contract";
import { TrackerTaskRelations } from "./TrackerTaskRelations";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
const task = (extra: Partial<Task> = {}): Task => ({ ...createFixtures("chair").tasks[0], task_type: "task", priority: "normal", links: [], children: [], revision: 7, capabilities: ["manage_task_links", "edit_task"], ...extra });
const epicLink: TaskLink = { link_id: "epic-link", kind: "epic", task: { task_id: "epic", task_key: "WEB-2", title: "Эпик", status: "open", deadline_at: null, starts_at: null, task_type: "epic" } };
async function openDialog(source: Task) {
  page = await mountWorkspace(<TrackerTaskRelations task={source} onEditParent={() => {}} />);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Добавить связь"]')!.click());await settle();
  return page.container.querySelector<HTMLDialogElement>("dialog")!;
}
const radios = (root: ParentNode) => [...root.querySelectorAll<HTMLInputElement>('input[type="radio"][name="relation_kind"]')];
const byId = (id: string) => document.getElementById(id)?.textContent;
const byIdElement = (id: string) => document.getElementById(id);
const described = (radio: HTMLInputElement) => radio.getAttribute("aria-describedby")!.split(" ").map(byId);

it("owner 2026-11-08, В1 variant Б: every kind of link is a radio card with its explanation in one group", async () => {
  const dialog = await openDialog(task());
  const group = [...dialog.querySelectorAll("fieldset")].find(item => item.querySelector(":scope > legend")?.textContent === "Тип связи")!;
  expect(dialog.querySelector('select[name="relation_kind"]')).toBeNull();expect(group).toBeDefined();
  const shown = radios(dialog);
  // An ordinary task: its parent and its own groups, not the members of an epic or a milestone.
  expect(shown.map(radio => radio.value)).toEqual(["parent", "related", "blocks", "blocked_by", "epic", "milestone"]);
  expect(shown.every(radio => group.contains(radio))).toBe(true);
  expect(shown.map(radio => byId(radio.getAttribute("aria-labelledby")!))).toEqual(["Родительская задача", "Связана с", "Блокирует", "Зависит от", "Входит в эпик", "Входит в веху"]);
  expect(shown.map(radio => described(radio))).toEqual([
    ["Эта задача станет подзадачей выбранной"], ["Ссылка в обе стороны, ни на что не влияет"],
    ["Выбранная ждёт эту: предупреждение, пока эта не «Закрыта»"], ["Эта ждёт выбранную: предупреждение, пока та не «Закрыта»"],
    ["Задача войдёт в эпик; эпик у задачи один"], ["Задача относится к контрольной точке плана"],
  ]);
  // The whole card is the radio's label; «Связана с» is chosen first and nothing is unavailable.
  expect(shown.every(radio => radio.closest("label")?.contains(byIdElement(radio.getAttribute("aria-labelledby")!)))).toBe(true);
  expect(shown.filter(radio => radio.checked).map(radio => radio.value)).toEqual(["related"]);
  expect(shown.some(radio => radio.disabled || radio.closest("label")!.hasAttribute("data-unavailable"))).toBe(false);
  expect(dialog.textContent).not.toContain("У задачи уже выбран эпик");
});

it("a chosen card is sent as the link kind and filters the targets by the group type", async () => {
  const epic = task({ task_id: "epic-target", task_key: "WEB-5", title: "Целевой эпик", task_type: "epic" });
  const list = vi.spyOn(tasksApi, "listPage").mockResolvedValue({ items: [epic], total: 1, next_cursor: null });
  const add = vi.spyOn(tasksApi, "addLink").mockResolvedValue(task({ revision: 8, links: [{ ...epicLink, task: { ...epicLink.task, task_id: epic.task_id } }] }));
  const source = task();
  const dialog = await openDialog(source);
  const card = radios(dialog).find(radio => radio.value === "epic")!.closest("label")!;
  await act(async () => card.click());await settle();
  expect(radios(dialog).filter(radio => radio.checked).map(radio => radio.value)).toEqual(["epic"]);
  const box = dialog.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => box.focus());await waitForPage(page!, () => !!dialog.querySelector('[role="option"]'));
  expect((list.mock.lastCall?.[0] as { task_type?: TaskType }).task_type).toBe("epic");
  await act(async () => dialog.querySelector<HTMLElement>('[role="option"]')!.click());
  await submit(dialog.querySelector("form")!);await waitForPage(page!);
  expect(add).toHaveBeenCalledExactlyOnceWith(source.task_id, { expected_revision: 7, target_task_id: epic.task_id, kind: "epic" });
});

it("an epic already chosen dims «Входит в эпик» and names the reason, the other kinds stay available", async () => {
  const dialog = await openDialog(task({ links: [epicLink] }));
  const epic = radios(dialog).find(radio => radio.value === "epic")!;
  expect(epic.disabled).toBe(true);expect(epic.closest("label")!.getAttribute("data-unavailable")).toBe("true");
  expect(described(epic)).toEqual(["Задача войдёт в эпик; эпик у задачи один", "У задачи уже выбран эпик. Чтобы заменить его, сначала удалите прежнюю связь."]);
  expect(radios(dialog).filter(radio => radio.disabled).map(radio => radio.value)).toEqual(["epic"]);
  expect(radios(dialog).filter(radio => radio.checked).map(radio => radio.value)).toEqual(["related"]);
});

it("the cards follow the task's type and the rights behind each kind", async () => {
  let dialog = await openDialog(task({ task_type: "epic" }));
  expect(radios(dialog).map(radio => radio.value)).toEqual(["parent", "related", "blocks", "blocked_by", "epic_member"]);
  expect(described(radios(dialog).at(-1)!)).toEqual(["Выбранная задача войдёт в этот эпик; эпик у задачи один"]);
  await page!.cleanup();
  dialog = await openDialog(task({ task_type: "milestone" }));
  expect(radios(dialog).map(radio => radio.value)).toEqual(["parent", "related", "blocks", "blocked_by", "milestone_member"]);
  expect(described(radios(dialog).at(-1)!)).toEqual(["Выбранная задача будет отнесена к этой вехе"]);
  await page!.cleanup();
  // Without the right to edit links only the parent remains, and it is chosen.
  dialog = await openDialog(task({ capabilities: ["edit_task"] }));
  expect(radios(dialog).map(radio => [radio.value, radio.checked])).toEqual([["parent", true]]);
  await page!.cleanup();
  dialog = await openDialog(task({ capabilities: ["manage_task_links"] }));
  expect(radios(dialog).map(radio => radio.value)).toEqual(["related", "blocks", "blocked_by", "epic", "milestone"]);
});

it("two cards in a row, one on a phone; the chosen card in the primary colour, the focused one ringed, an unavailable one dimmed", () => {
  const css = readFileSync(`${__dirname}/TrackerTaskStage2.module.css`, "utf8");
  expect(css).toMatch(/\.kindGrid \{ display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);/);
  expect(css).toMatch(/@media\(max-width:600px\) \{ \.kindGrid \{ grid-template-columns:minmax\(0,1fr\); \} \}/);
  expect(css).toMatch(/\.kindCard:has\(input:checked\) \{ border-color:var\(--primary\);/);
  expect(css).toMatch(/\.kindCard:has\(input:focus-visible\) \{ outline:2px solid var\(--primary\);/);
  expect(css).toMatch(/\.kindCards \.kindCard>input\[type="radio"\]:focus-visible \{ outline:none; \}/);
  expect(css).toMatch(/\.kindCard\[data-unavailable\] \{ opacity:\.45;cursor:not-allowed; \}/);
});
