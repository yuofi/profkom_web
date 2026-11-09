import { expect, it } from "vitest";
import { emptyCriteria } from "./api/contract";
import type { AccountingBatch, AccountingRow } from "./api/kkr.api";
import { accountingSummary, formatHours, parseHours } from "./kkrAccounting";

const row = (hours: number | null, evaluation: AccountingRow["evaluation"], excluded = false, index = 0): AccountingRow => ({
  assignment_id: `a${index}`, assignee: { user_id: index, display_name: `Исполнитель ${index}`, avatar_url: null },
  hours, evaluation, excluded, effective_completed_at: null, revision: 1, is_current: true,
});
const batch = (rows: AccountingRow[], criteria = emptyCriteria()): AccountingBatch => ({
  task_id: "task", public_revision: 1, revision: 1, criteria, closed_at: null, season_closed: false,
  assigned_at: "2026-11-01T09:00:00Z", deadline_at: null, assignments: rows.map((value, index) => ({ ...value, assignment_id: `a${index}` })), capabilities: [],
});

it("sums the summary of the owner's screenshot: excluded executors count neither as rated nor in the hours", () => {
  const criteria = { ...emptyCriteria(), unique: true, in_person: true, creative: true, fixed_time: true };
  expect(accountingSummary(batch([row(1.5, null, true), row(2.5, 1), row(3, 0), row(4, 1.5)], criteria)))
    .toBe("Оценено 3 из 3 · 1 исключён · всего 9,5 ч · признаков задачи: 4 из 5");
});

it("names the excluded in the right Russian form and leaves them out when there are none", () => {
  const excluded = (count: number) => accountingSummary(batch([row(1, 1), ...Array.from({ length: count }, () => row(1, null, true))]));
  expect(excluded(0)).toBe("Оценено 1 из 1 · всего 1 ч · признаков задачи: 0 из 5");
  expect(excluded(2)).toContain("· 2 исключены ·");
  expect(excluded(5)).toContain("· 5 исключены ·");
  expect(excluded(11)).toContain("· 11 исключены ·");
  expect(excluded(21)).toContain("· 21 исключён ·");
});

it("says that nothing is rated yet, and what is left when every executor is excluded or there is none", () => {
  expect(accountingSummary(batch([row(null, null), row(2, null)]))).toBe("Оценок пока нет · всего 2 ч · признаков задачи: 0 из 5");
  expect(accountingSummary(batch([row(1, null, true), row(2, null, true)]))).toBe("2 исключены · всего 0 ч · признаков задачи: 0 из 5");
  expect(accountingSummary(batch([], { ...emptyCriteria(), creative: true }))).toBe("Исполнителей нет · признаков задачи: 1 из 5");
});

it("adds hours without the float tail and writes them with a comma", () => {
  expect(accountingSummary(batch([row(0.1, 1), row(0.2, 1)]))).toContain("всего 0,3 ч");
  expect(formatHours(2.5)).toBe("2,5");expect(formatHours(0)).toBe("0");expect(formatHours(null)).toBe("");
});

it("reads typed hours with a comma or a dot; an empty field is no hours and a lone comma is not a number yet", () => {
  expect(parseHours("2,5")).toBe(2.5);expect(parseHours(" 3.25 ")).toBe(3.25);expect(parseHours("4,")).toBe(4);expect(parseHours("0")).toBe(0);
  expect(parseHours("")).toBeNull();expect(parseHours("  ")).toBeNull();
  expect(parseHours(",")).toBeUndefined();expect(parseHours("-1")).toBeUndefined();
});
