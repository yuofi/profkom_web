// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { MarkdownContent } from "./MarkdownContent";

const { mathLoaded, codeLoaded } = vi.hoisted(() => ({ mathLoaded: vi.fn(), codeLoaded: vi.fn() }));
vi.mock("./markdownMath", async original => { mathLoaded();return await original<typeof import("./markdownMath")>(); });
vi.mock("./MarkdownCode", async original => { codeLoaded();return await original<typeof import("./MarkdownCode")>(); });
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });
const box = () => page!.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

it("plain Markdown parses as before without loading formulas or highlighting", async () => {
  page = await mountWorkspace(<MarkdownContent body={"- [ ] Шаг\n\n`код` и ```не блок```\n\n```\nтекст\n```"} onChecklistToggle={() => {}} />);
  expect(box().disabled).toBe(false);expect(box().getAttribute("aria-label")).toBe("Отметить: Шаг");
  await waitForPage(page);
  expect(mathLoaded).not.toHaveBeenCalled();expect(codeLoaded).not.toHaveBeenCalled();
  expect(page.container.querySelector("figcaption")?.textContent).toBe("Текст");
});
it("text with $ keeps its marks locked until formulas load, so a marker inside $$ never looks like a task", async () => {
  const toggle = vi.fn();
  page = await mountWorkspace(<MarkdownContent body={"- [ ] Настоящий пункт\n\n$$\n- [ ] Внутри формулы\n$$\n\nИ строчная $x^2$"} onChecklistToggle={toggle} />);
  expect([...page.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(input => input.disabled)).toBe(true);
  await waitForPage(page, () => !!page!.container.querySelector(".katex"));
  expect(mathLoaded).toHaveBeenCalledOnce();
  const boxes = page.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(boxes).toHaveLength(1);expect(boxes[0].disabled).toBe(false);expect(boxes[0].getAttribute("aria-label")).toBe("Отметить: Настоящий пункт");
});
