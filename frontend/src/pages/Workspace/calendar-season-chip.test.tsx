// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { CalendarPage } from "./WorkspacePages";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, change } from "../../test/workspace";
import { workspaceApi } from "../../utils/api/workspace.api";
import type { CalendarItem } from "../../utils/api/contract";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks();vi.useRealTimers(); });
async function mount() {
  vi.useFakeTimers({ toFake: ["Date"] });vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));mock = installMockTransport("chair", { delay: 0 });const first = mock.state.seasons[0];first.title = "Тестовый осенний сезон с очень длинным полным названием для календаря";first.state = "open";
  const second = { ...first, season_id: "season-other", title: "Другой рабочий сезон", state: "planned" as const };mock.state.seasons.push(second);
  const items: CalendarItem[] = [
    { id: "deadline", season_id: first.season_id, kind: "task_deadline", title: "Проверить памятку", starts_at: "2026-10-27T11:00:00Z", ends_at: null, target: { kind: "task", id: "task-calendar" } },
    { id: "meeting", season_id: second.season_id, kind: "meeting", title: "Обсудить программу", starts_at: "2026-10-27T12:00:00Z", ends_at: null, target: { kind: "subevent", id: "team-calendar" } },
  ];vi.spyOn(workspaceApi, "calendar").mockResolvedValue({ items, next_cursor: null });
  page = await mountWorkspace(<Routes><Route path="/calendar" element={<CalendarPage />} /><Route path="/seasons/:id" element={<h1>Сезон открыт</h1>} /><Route path="/tasks/:id" element={<h1>Задача открыта</h1>} /><Route path="/meetings/subevent/:id" element={<h1>Созвон открыт</h1>} /></Routes>, { path: "/calendar" });await waitForPage(page);return { first, second };
}
it("keeps month cells compact and identifies the full season in its keyboard preview", async () => {
  const { first } = await mount();expect(page!.container.querySelector('a[aria-label^="Открыть сезон:"]')).toBeNull();
  await act(async () => page!.container.querySelector<HTMLAnchorElement>('a[href="/tasks/task-calendar"]')!.focus());await waitForPage(page!);
  const chips = [...document.querySelectorAll<HTMLAnchorElement>(`[role="tooltip"] a[href="/seasons/${first.season_id}"]`)];expect(chips).toHaveLength(1);
  for (const chip of chips) { expect(chip.textContent).toBe(`Сезон:${first.title}`);expect(chip.getAttribute("title")).toBe(`Сезон: ${first.title}`);expect(chip.getAttribute("aria-label")).toBe(`Открыть сезон: ${first.title}`);expect(chip.querySelector("img")).toBeNull();expect(chip.querySelector("svg[aria-hidden=true]")).not.toBeNull();expect(chip.parentElement?.closest("a")).toBeNull(); }
});
it("opens the actual season through its chip while the task title still opens the task", async () => {
  const { first } = await mount();await act(async () => page!.container.querySelector<HTMLAnchorElement>('a[href="/tasks/task-calendar"]')!.focus());await waitForPage(page!);await act(async () => document.querySelector<HTMLAnchorElement>(`[role="tooltip"] a[href="/seasons/${first.season_id}"]`)!.click());expect(page!.container.querySelector("h1")?.textContent).toBe("Сезон открыт");await page!.cleanup();page = undefined;mock!.restore();mock = undefined;vi.restoreAllMocks();
  await mount();await act(async () => page!.container.querySelector<HTMLAnchorElement>('a[href="/tasks/task-calendar"]')!.click());expect(page!.container.querySelector("h1")?.textContent).toBe("Задача открыта");
});
it("keeps meeting navigation, season filtering and the Moscow today marker intact", async () => {
  const { second } = await mount();expect(page!.container.querySelector('[aria-current="date"]')?.getAttribute("aria-label")).toBe("2026-10-27");expect(page!.container.querySelector('a[href="/meetings/subevent/team-calendar"]')).not.toBeNull();
  await change([...page!.container.querySelectorAll<HTMLSelectElement>("select")].find(select => select.closest("label")?.textContent?.startsWith("Сезон"))!, second.season_id);await waitForPage(page!);expect(page!.container.textContent).not.toContain("Проверить памятку");expect(page!.container.textContent).toContain("Обсудить программу");expect(page!.container.querySelector('[aria-current="date"]')?.getAttribute("aria-label")).toBe("2026-10-27");expect([...page!.container.querySelectorAll<HTMLAnchorElement>('a[aria-label^="Открыть сезон:"]')].every(link => link.getAttribute("href") === `/seasons/${second.season_id}`)).toBe(true);
});
