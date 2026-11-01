// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import type { Task, TaskPublicStatus } from "../../utils/api/contract";
import { TaskStatusMenu } from "./TaskStatusMenu";
import { publicStatusNames } from "./trackerStatus";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
const statuses = Object.keys(publicStatusNames) as TaskPublicStatus[];
const task = (status: TaskPublicStatus, capabilities: string[]): Task => ({ ...createFixtures("chair").tasks[0], status, allowed_statuses: statuses, capabilities });
const rule = (css: string, selector: string) => css.match(new RegExp(`(?:^|[\\n}])\\s*${selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

it.each(statuses.flatMap(status => [[status, "menu"], [status, "locked"]] as const))("owner 2026-11-01: a %s chip (%s) is sized by every status name and shows only its own", async (status, kind) => {
  transport = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<TaskStatusMenu task={task(status, kind === "menu" ? ["change_task_status"] : [])} />);
  const chip = page.container.querySelector<HTMLElement>(kind === "menu" ? 'button[aria-haspopup="menu"]' : '[role="img"]')!;
  const label = chip.querySelector<HTMLElement>("[data-sizer]")!;
  expect(label.dataset.sizer!.split("\n")).toEqual(Object.values(publicStatusNames));
  expect(label.textContent).toBe(publicStatusNames[status]);expect(chip.textContent).toBe(publicStatusNames[status]);
  expect(chip.getAttribute("aria-label")).toMatch(new RegExp(`^Статус задачи: ${publicStatusNames[status]}`));
});
it("owner 2026-11-01: the label box takes the longest name, the locked chip keeps the arrow's place and its label size", () => {
  const css = readFileSync(`${__dirname}/TaskStatusMenu.module.css`, "utf8");
  expect(rule(css, ".chipLabel::after")).toMatch(/content:\s*attr\(data-sizer\);[\s\S]*height:\s*0;[\s\S]*visibility:\s*hidden;[\s\S]*white-space:\s*pre/);
  expect(rule(css, ".chipLabel > span")).toMatch(/text-overflow:\s*ellipsis;[\s\S]*text-align:\s*center/);
  // The 16px size belongs to the arrow glyph only; the locked chip used to catch it on its label (36px instead of 32px).
  expect(css).not.toMatch(/\.chip > span:last-child/);
  expect(rule(css, ".chip > [data-icon], .static::after")).toMatch(/font-size:\s*16px/);
  expect(rule(css, ".static::after")).toMatch(/content:\s*"";[\s\S]*width:\s*1em/);
});
it("the phone status sheet opens above the feedback button", () => {
  const menu = readFileSync(`${__dirname}/TaskStatusMenu.module.css`, "utf8"), fab = readFileSync(`${__dirname}/../../components/Workspace/FeedbackButton.module.css`, "utf8");
  const sheet = menu.match(/@media\(max-width: 768px\)[^\n]*\.menu \{([^}]*)\}/)?.[1] ?? "";
  const above = Number(sheet.match(/z-index:\s*(\d+)/)?.[1]), button = Number(rule(fab, ".trigger").match(/z-index:\s*(\d+)/)?.[1]);
  expect(sheet).toMatch(/position:\s*fixed/);expect(above).toBeGreaterThan(button);
});
it("keeps the keyboard focus on the chip while the chosen status saves and after it", async () => {
  transport = installMockTransport("chair", { delay: 0 });
  const open = task("open", ["change_task_status"]);let saved: (value: Task) => void = () => {};
  vi.spyOn(tasksApi, "changeStatus").mockImplementation(() => new Promise<Task>(resolve => { saved = resolve; }));
  page = await mountWorkspace(<TaskStatusMenu task={open} />);
  const chip = page.container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  await act(async () => { chip.focus();chip.click(); });
  const item = [...page.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === publicStatusNames.in_progress)!;
  // Enter on a focused menu item presses it.
  await act(async () => { item.focus();item.click(); });
  expect(page.container.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(chip);
  expect(chip.disabled).toBe(false);expect(chip.getAttribute("aria-disabled")).toBe("true");expect(chip.getAttribute("aria-busy")).toBe("true");
  // A second press while saving neither opens the menu nor sends another change.
  await act(async () => chip.click());
  expect(page.container.querySelector('[role="menu"]')).toBeNull();expect(tasksApi.changeStatus).toHaveBeenCalledTimes(1);
  await act(async () => saved({ ...open, revision: open.revision + 1, status: "in_progress" }));
  await waitForPage(page, () => !chip.hasAttribute("aria-disabled"));
  expect(document.activeElement).toBe(chip);expect(chip.hasAttribute("aria-busy")).toBe(false);
});
it("draws the saving chip as before, without `disabled`", () => {
  const css = readFileSync(`${__dirname}/TaskStatusMenu.module.css`, "utf8");
  expect(rule(css, '.chip[aria-disabled="true"]')).toMatch(/cursor:\s*progress;\s*opacity:\s*\.7/);
});
