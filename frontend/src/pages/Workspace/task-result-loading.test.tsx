// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskStatusMenu } from "./TaskStatusMenu";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, change, field, submit } from "../../test/workspace";
const { loaded } = vi.hoisted(() => ({ loaded: vi.fn() }));
vi.mock("./TaskResultDialog", async original => { loaded();return await original<typeof import("./TaskResultDialog")>(); });
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();mock?.restore(); });
it("does not load result Markdown/files for a status chip and preserves the explicit submission form", async () => {
  mock = installMockTransport("chair", { delay: 0 });const original = createFixtures("chair").tasks[0];
  const task = { ...original, capabilities: [...original.capabilities, "submit_task_result"] };
  page = await mountWorkspace(<TaskStatusMenu task={task} />);await waitForPage(page);
  expect(loaded).not.toHaveBeenCalled();
  await page.cleanup();page = undefined;
  page = await mountWorkspace(<TaskStatusMenu task={task} variant="actions" />);await waitForPage(page);
  expect(loaded).not.toHaveBeenCalled();
  const open = [...page.container.querySelectorAll("button")].find(button => button.textContent === "Сдать результат")!;
  await act(async () => open.click());await waitForPage(page, () => !!page!.container.querySelector('[name="body"]'));
  expect(loaded).toHaveBeenCalledOnce();
  await change(field(page.container, "body"), "Результат с **форматированием**");
  await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(mock.state.tasks.find(item => item.task_id === task.task_id)?.submissions?.at(-1)?.text.body).toBe("Результат с **форматированием**");
});
