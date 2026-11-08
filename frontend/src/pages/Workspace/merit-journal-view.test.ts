import { expect, it } from "vitest";
import { emptyCriteria, richText, type HistoryEntry, type Merit, type MeritJournalItem } from "../../utils/api/contract";
import { changeLines, dayHeading, journalDays, meritTeam, parseTeam, shortName, teamLabel, teamOptions, teamValue } from "./meritJournalView";

const egor = { user_id: 7, display_name: "Андреев Егор Петрович", avatar_url: null };
/** Dates keep their parts together with no-break spaces. */
const spaced = (text: string) => text.replace(/\u00a0/g, " ");

it("says a recipient's added, removed and changed inputs in one short line each", () => {
  expect(changeLines({ field: "recipients", label: "Добавлен получатель", before: null, after: { user: egor, hours: 2, evaluation: 1, completed_at: null } }))
    .toEqual([{ tone: "add", text: "Получатели: +Андреев Егор (2 ч, оценка 1)" }]);
  expect(changeLines({ field: "recipients", label: "Убран получатель", before: { user: egor, hours: 3, evaluation: 1, completed_at: null }, after: null }))
    .toEqual([{ tone: "remove", text: "Получатели: −Андреев Егор (было 3 ч)" }]);
  expect(changeLines({ field: "recipients", label: "Исходные поля получателя", before: { user: egor, hours: 3, evaluation: 1 }, after: { user: egor, hours: 4, evaluation: 1.5 } }).map(line => line.text))
    .toEqual(["Андреев Егор — часы: 3 → 4", "Андреев Егор — оценка: 1 → 1,5"]);
  const dates = changeLines({ field: "recipients", label: "Исходные поля получателя", before: { user: egor, completed_at: null }, after: { user: egor, completed_at: "2026-10-30T17:00:00Z" } });
  expect(spaced(dates[0].text)).toBe("Андреев Егор — дата выполнения: не задана → 30 окт. 2026 г., 20:00");
});

it("names criteria, the title, the dates and the description in words", () => {
  expect(changeLines({ field: "criteria", label: "Критерии", before: { urgent: false, physical: true }, after: { urgent: true, physical: false } }).map(line => line.text))
    .toEqual(["Критерий «Срочная задача»: нет → да", "Критерий «Требуется ли физическая сила»: да → нет"]);
  expect(changeLines({ field: "title", label: "Название", before: "Экскурсия", after: "Экскурсия для первокурсников" }))
    .toEqual([{ text: "Название: «Экскурсия» → «Экскурсия для первокурсников»" }]);
  expect(changeLines({ field: "description", label: "Описание", before: "Старый текст", after: "Новый текст" })).toEqual([{ text: "Описание изменено" }]);
  expect(spaced(changeLines({ field: "deadline_at", label: "Дедлайн", before: "2026-10-29T17:00:00Z", after: "2026-10-30T17:00:00Z" })[0].text))
    .toBe("Дедлайн: 29 окт. 2026 г., 20:00 → 30 окт. 2026 г., 20:00");
  expect(changeLines({ field: "status", label: "Состояние", before: null, after: true })).toEqual([{ text: "Состояние: — → да" }]);
});

it("keeps surname and name of a person and names the team of a record", () => {
  expect(shortName(egor)).toBe("Андреев Егор");
  expect(shortName({ display_name: "Бывший участник" })).toBe("Бывший участник");
  expect(teamLabel({ kind: "chair", title: null })).toBe("Председатель");
  expect(teamLabel({ kind: "block", title: "Медиа" })).toBe("Блок «Медиа»");
  expect(teamLabel({ kind: "subevent", title: null })).toBe("Подмероприятие");
  expect(teamLabel({ kind: "event", title: "Фестиваль культур" })).toBe("Фестиваль культур");
});

const record = (merit: Partial<Merit>): Merit => ({ season_id: "season-1", source_kind: "chair_merit", title: "Запись", description: richText(""), assigned_at: "2026-10-01T10:00:00Z",
  deadline_at: "2026-10-02T10:00:00Z", criteria: emptyCriteria(), recipients: [], reason: "", merit_id: "m", created_by: egor, created_at: "2026-10-01T10:00:00Z", revision: 1, capabilities: [], ...merit });

it("keeps a team in the select and the URL by its kind and id", () => {
  expect(meritTeam(record({}))).toEqual({ kind: "chair", id: null });
  expect(meritTeam(record({ source_kind: "head_merit", event_id: "event-1" }))).toEqual({ kind: "event", id: "event-1" });
  expect(meritTeam(record({ source_kind: "block_volunteer", scope: { kind: "block", id: "block-media" } }))).toEqual({ kind: "block", id: "block-media" });
  for (const team of [{ kind: "chair", id: null }, { kind: "block", id: "block-media" }, { kind: "subevent", id: "sub:1" }] as const)
    expect(parseTeam(teamValue(team))).toEqual(team);
  expect(parseTeam("block:")).toBeNull();
  expect(parseTeam("galaxy:1")).toBeNull();
  expect(parseTeam(null)).toBeNull();
});

it("offers the teams of the records once each, by name, and keeps the chosen one", () => {
  const names = { blocks: [{ block_id: "block-media", name: "Медиа" }], events: [{ event_id: "event-1", title: "Фестиваль культур" }], subs: [] };
  const merits = [record({}), record({ source_kind: "block_volunteer", scope: { kind: "block", id: "block-media" } }), record({ source_kind: "chair_merit" }),
    record({ source_kind: "head_merit", event_id: "event-1" })];
  expect(teamOptions(merits, names, null)).toEqual([
    { value: "block:block-media", label: "Блок «Медиа»" }, { value: "chair", label: "Председатель" }, { value: "event:event-1", label: "Фестиваль культур" }]);
  expect(teamOptions([], names, { kind: "subevent", id: "gone" })).toEqual([{ value: "subevent:gone", label: "Подмероприятие" }]);
});

it("groups the edits by Moscow day and names the year of another year only", () => {
  const item = (id: string, created_at: string): MeritJournalItem => ({
    entry: { id, created_at } as HistoryEntry, merit: { merit_id: "m", title: "Запись", source_kind: "chair_merit", team: { kind: "chair", id: null, title: null } } });
  const now = Date.parse("2026-11-08T09:00:00Z");
  // 21:30 UTC on 7 November is already Sunday 8 November in Moscow.
  const days = journalDays([item("a", "2026-11-07T21:30:00Z"), item("b", "2026-11-07T20:30:00Z"), item("c", "2026-11-07T08:00:00Z"), item("d", "2025-11-07T08:00:00Z")], now);
  expect(days.map(day => [day.heading, day.items.map(entry => entry.entry.id)])).toEqual([
    ["Воскресенье, 8 ноября", ["a"]], ["Суббота, 7 ноября", ["b", "c"]], ["Пятница, 7 ноября 2025 г.", ["d"]]]);
  expect(dayHeading("2026-01-01T00:00:00+03:00", now)).toBe("Четверг, 1 января");
});
