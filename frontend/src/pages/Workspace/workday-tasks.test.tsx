// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { WorkdayTasks } from "./WorkdayTasks";
import { deadlineHint } from "./workdayDates";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace } from "../../test/workspace";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });
it("labels deadlines by the Moscow calendar day and preserves the exact time", () => {
  const now = Date.parse("2026-10-28T21:30:00Z");
  expect(deadlineHint("2026-10-29T12:00:00Z", now, false)).toBe("Сегодня, 15:00");
  expect(deadlineHint("2026-10-29T21:30:00Z", now, false)).toBe("Завтра, 00:30");
  expect(deadlineHint(null, now, false)).toBe("Без срока");
  expect(deadlineHint("invalid", now, false)).toBe("Без срока");
});
it("shows overdue minutes, hours and full days without zero-day labels", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  expect(deadlineHint("2026-10-29T11:59:30Z", now, true)).toBe("Просрочено: 1 мин");
  expect(deadlineHint("2026-10-29T08:00:00Z", now, true)).toBe("Просрочено: 4 ч");
  expect(deadlineHint("2026-10-27T11:00:00Z", now, true)).toBe("Просрочено: 2 дн.");
});
it("opens the task from its whole compact row without nested person links", async () => {
  const task = { ...createFixtures("chair").tasks[0], title: "Проверить памятку", task_key: "ITWEB-7", deadline_at: "2026-10-29T12:00:00Z" };
  page = await mountWorkspace(<Routes><Route path="/" element={<WorkdayTasks tasks={[task]} now={Date.parse("2026-10-29T10:00:00Z")} />} /><Route path="/tasks/:id" element={<h1>Задача открыта</h1>} /></Routes>);
  const row = page.container.querySelector<HTMLAnchorElement>("li > a")!;
  expect(row.textContent).toContain("ITWEB-7");expect(row.textContent).toContain("Проверить памятку");expect(row.textContent).toContain("Сегодня, 15:00");
  expect(page.container.querySelectorAll("li a")).toHaveLength(1);
  await act(async () => row.click());expect(page.container.querySelector("h1")?.textContent).toBe("Задача открыта");
});
