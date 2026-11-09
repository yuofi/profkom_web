import { expect, it } from "vitest";
import { emptyCriteria, richText, type Contribution, type Merit } from "../../utils/api/contract";
import type { ContactInfoOut } from "../../utils/api/types";
import { applyFilters, buildRows, filterOptions, kkr, monthLabel, noFilters, num, recordDay, shareText } from "./meritRecordListView";

// «Записи» of «Особые заслуги и волонтёры» (owner B8, variant Г): each recipient keeps their own values.
const contact = (user_id: number, surname: string, name: string, patronymic = ""): ContactInfoOut =>
  ({ user_id, surname, name, patronymic, photo_url: "/avatars/default.svg" }) as ContactInfoOut;
const contacts = [contact(101, "Смирнова", "Анна", "Петровна"), contact(102, "Петров", "Иван"), contact(103, "Орлова", "Мария"), contact(1, "Ёлкин", "Пётр")];
let sequence = 0;
function merit(patch: Partial<Merit>): Merit {
  sequence += 1;
  return { merit_id: `merit-${sequence}`, season_id: "season-1", source_kind: "chair_merit", event_id: null, scope: null, title: `Запись ${sequence}`,
    description: richText(""), assigned_at: "2026-10-01T10:00:00Z", deadline_at: "2026-10-10T10:00:00Z", criteria: emptyCriteria(), recipients: [],
    reason: "", created_by: { user_id: 1, display_name: "Ёлкин Пётр", avatar_url: null }, created_at: "2026-10-11T10:00:00Z", revision: 1, capabilities: [], ...patch };
}
const share = (user_id: number, hours: number, evaluation: -1 | 0 | 1 | 1.5, completed_at: string | null = null) => ({ user_id, hours, evaluation, completed_at });
const credit = (m: Merit, user_id: number, score: number | null) => ({ merit_id: m.merit_id, user: { user_id, display_name: "", avatar_url: null }, score }) as Contribution;

it("prints KKR with two decimals and a comma, hours and evaluations as the site does, with a real minus", () => {
  expect([kkr(4.5), kkr(12), kkr(-3.2), kkr(0), kkr(0.005)]).toEqual(["4,50", "12,00", "−3,20", "0,00", "0,01"]);
  expect([num(2.5), num(-1), num(1.5), num(3)]).toEqual(["2,5", "−1", "1,5", "3"]);
});

it("keeps each recipient's own hours, evaluation, completion and KKR, with no total for the record", () => {
  const m = merit({ title: "Звук на концерте", deadline_at: "2026-10-10T10:00:00Z",
    recipients: [share(101, 3, 1.5, "2026-10-09T10:00:00Z"), share(102, 5, -1), share(103, 2, 1, "2026-10-12T10:00:00Z")] });
  const [row] = buildRows([m], [credit(m, 101, 6.4549), credit(m, 102, -7.125), credit(m, 103, null)], contacts);
  expect(row.shares.map(x => [x.person.short, x.hours, x.evaluation, x.late, x.score])).toEqual([
    ["Смирнова А.", 3, 1.5, false, 6.45], ["Петров И.", 5, -1, false, -7.13], ["Орлова М.", 2, 1, true, null]]);
  // Nothing on the row sums the recipients.
  expect(Object.keys(row).sort()).toEqual(["author", "merit", "month", "shares", "team", "teamKey"]);
  expect(row.shares[0].person.full).toBe("Смирнова Анна Петровна");
  expect(shareText(row.shares[1], true)).toBe("5 ч · оценка −1 · ККР −7,13");
  expect(shareText(row.shares[2], true)).toBe("2 ч · оценка 1 · ККР —");
  expect(shareText(row.shares[0], false)).toBe("3 ч · оценка 1,5");
});

it("names people missing from the directory as the server does and keeps a former account whole", () => {
  const m = merit({ recipients: [share(555, 1, 1)], created_by: { user_id: 777, display_name: "Участник 777", avatar_url: null } });
  const gone = merit({ created_by: { user_id: null, display_name: "Обезличенный участник", avatar_url: null } });
  const named = merit({ created_by: { user_id: 888, display_name: "Кузнецова Ольга Игоревна", avatar_url: null } });
  const [first, second, third] = buildRows([m, gone, named], [], contacts);
  expect([first.shares[0].person.short, first.author.short, second.author.short, third.author.short]).toEqual(["Участник #555", "Участник 777", "Обезличенный участник", "Кузнецова О."]);
  expect(second.author.key).toBe("name:Обезличенный участник");
});

it("lists the newest work first and names the team as the season journal does", () => {
  const names = { blocks: [{ block_id: "block-it", name: "IT" }], events: [{ event_id: "event-1", title: "День математика" }], subs: [{ subevent_id: "sub-1", title: "Лекции" }] };
  const rows = buildRows([
    merit({ title: "Старая", assigned_at: "2026-09-02T10:00:00Z" }),
    merit({ title: "Блок", source_kind: "block_volunteer", scope: { kind: "block", id: "block-it" }, assigned_at: "2026-10-30T10:00:00Z" }),
    merit({ title: "Главорг", source_kind: "head_merit", event_id: "event-1", assigned_at: "2026-10-05T10:00:00Z" }),
    merit({ title: "Подмероприятие", source_kind: "subevent_volunteer", scope: { kind: "subevent", id: "sub-1" }, assigned_at: "2026-11-01T10:00:00Z" }),
  ], [], contacts, names);
  expect(rows.map(row => [row.merit.title, row.team, row.teamKey, row.month])).toEqual([
    ["Подмероприятие", "Лекции", "subevent:sub-1", "2026-11"], ["Блок", "Блок «IT»", "block:block-it", "2026-10"],
    ["Главорг", "День математика", "event:event-1", "2026-10"], ["Старая", "Председатель", "chair", "2026-09"]]);
  const options = filterOptions(rows);
  expect(options.team.map(([, label]) => label)).toEqual(["Председатель", "Блок «IT»", "День математика", "Лекции"]);
  expect(options.kind).toEqual([["chair_merit", "Заслуги председателя"], ["head_merit", "Заслуги главоргов"], ["block_volunteer", "Волонтёры блоков"], ["subevent_volunteer", "Волонтёры мероприятий"]]);
  expect(options.month).toEqual([["2026-11", "Ноябрь 2026"], ["2026-10", "Октябрь 2026"], ["2026-09", "Сентябрь 2026"]]);
  expect(monthLabel("2027-01")).toBe("Январь 2027");
});

it("a Moscow month and day: the last evening of October by Moscow is already November", () => {
  const [row] = buildRows([merit({ assigned_at: "2026-10-31T22:30:00Z" })], [], contacts);
  expect(row.month).toBe("2026-11");
  const now = Date.parse("2026-11-09T10:00:00Z");
  expect(recordDay("2026-10-31T22:30:00Z", now)).toBe("1\u00a0нояб.");
  expect(recordDay("2025-12-01T10:00:00Z", now)).toMatch(/^1\u00a0дек\.\u00a02025/);
});

it("filters by every word of the search in the title, a recipient or the author, and by each list", () => {
  const rows = buildRows([
    merit({ title: "Фотосъёмка концерта", recipients: [share(101, 2, 1)], assigned_at: "2026-10-03T10:00:00Z" }),
    merit({ title: "Сценарий вечера", source_kind: "head_merit", event_id: "event-1", recipients: [share(102, 4, 1), share(103, 1, 0)], assigned_at: "2026-11-02T10:00:00Z",
      created_by: { user_id: 102, display_name: "Петров Иван", avatar_url: null } }),
    merit({ title: "Звук на концерте", recipients: [share(103, 3, 1.5)], assigned_at: "2026-11-04T10:00:00Z" }),
  ], [], contacts);
  const titles = (patch: Partial<typeof noFilters>) => applyFilters(rows, { ...noFilters, ...patch }).map(row => row.merit.title);
  expect(titles({})).toHaveLength(3);
  expect(titles({ q: "КОНЦЕРТ" })).toEqual(["Звук на концерте", "Фотосъёмка концерта"]);
  expect(titles({ q: "орлова" })).toEqual(["Звук на концерте", "Сценарий вечера"]);
  expect(titles({ q: "мария звук" })).toEqual(["Звук на концерте"]);
  // The author, «ё» typed as «е».
  expect(titles({ q: "елкин" })).toEqual(["Звук на концерте", "Фотосъёмка концерта"]);
  expect(titles({ team: "event:event-1" })).toEqual(["Сценарий вечера"]);
  expect(titles({ person: "103" })).toEqual(["Звук на концерте", "Сценарий вечера"]);
  expect(titles({ author: "102" })).toEqual(["Сценарий вечера"]);
  expect(titles({ kind: "chair_merit" })).toEqual(["Звук на концерте", "Фотосъёмка концерта"]);
  expect(titles({ month: "2026-10" })).toEqual(["Фотосъёмка концерта"]);
  expect(titles({ month: "2026-11", person: "103", q: "звук" })).toEqual(["Звук на концерте"]);
});
