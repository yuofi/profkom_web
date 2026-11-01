// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace } from "../../test/workspace";
import type { Task, TaskPublicStatus } from "../../utils/api/contract";
import { TaskStatusMenu } from "./TaskStatusMenu";
import { publicStatusNames } from "./trackerStatus";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined; });
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
