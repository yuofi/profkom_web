// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace } from "../test/workspace";
import { tasksApi } from "./api/tasks.api";
import { useTaskPrefetch } from "./routePrefetch";
import type { Task } from "./api/contract";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });

function Row() {
  const prefetch = useTaskPrefetch(target => target instanceof Element && !!target.closest("a,button"));
  return <table><tbody><tr {...prefetch("task-1")}><td data-cell>Задача</td><td><a href="/contacts/7">Иван Петров</a></td></tr></tbody></table>;
}
const over = (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); });
const rest = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

it("PF-04: resting on a row starts the task only; resting on a person's chip in it starts nothing", async () => {
  const get = vi.spyOn(tasksApi, "get").mockResolvedValue({ task_id: "task-1" } as Task);
  const comments = vi.spyOn(tasksApi, "comments").mockResolvedValue({ items: [], next_cursor: null } as unknown as Awaited<ReturnType<typeof tasksApi.comments>>);
  page = await mountWorkspace(<Row />);
  const chip = page.container.querySelector("a")!, cell = page.container.querySelector("[data-cell]")!;
  await over(chip);await rest(200);
  expect(get).not.toHaveBeenCalled();
  // From the chip back to the row: the rest there counts.
  await over(cell);await rest(60);await over(chip);await rest(200);
  expect(get).not.toHaveBeenCalled();
  await over(cell);await rest(200);
  expect(get).toHaveBeenCalledExactlyOnceWith("task-1");expect(comments).not.toHaveBeenCalled();
});
