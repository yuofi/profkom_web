/** The season journal of merit record edits (B9, owner 2026-11-08) in words: the team of a record,
 *  the short lines of a change and the Moscow days the edits are grouped by. */
import type { HistoryChange, Merit, MeritJournalItem, MeritTeam, UserRef } from "../../utils/api/contract";
import { criteriaLabels } from "../../utils/kkrCriteria";
import { capitalizeFirst, moscowDay } from "../../utils/calendar";
import { displayDate } from "../../utils/dates";
import { metricValue } from "./seasonAnalyticsView";

export type JournalTeam = Pick<MeritTeam, "kind" | "id">;
export type JournalLine = { text: string; tone?: "add" | "remove" };
/** Names of the season's teams as GET /merits/contexts gives them. */
export interface TeamNames {
  blocks: { block_id: string; name: string }[];
  events: { event_id: string; title: string }[];
  subs: { subevent_id: string; title: string }[];
}

/** The team a record counts for, as GET /merits/history names it: the chair, the event of a
 *  head merit, the block (stable id) or the subevent of a volunteer record. */
export function meritTeam(merit: Pick<Merit, "source_kind" | "event_id" | "scope">): JournalTeam {
  if (merit.source_kind === "chair_merit") return { kind: "chair", id: null };
  if (merit.source_kind === "head_merit") return { kind: "event", id: merit.event_id ?? null };
  return { kind: merit.source_kind === "block_volunteer" ? "block" : "subevent", id: merit.scope?.id ?? null };
}
/** The filter's value of a team in the select and the URL: «chair», «block:<id>», «event:<id>». */
export const teamValue = (team: JournalTeam) => team.kind === "chair" ? "chair" : `${team.kind}:${team.id ?? ""}`;
export function parseTeam(value: string | null): JournalTeam | null {
  if (value === "chair") return { kind: "chair", id: null };
  const match = /^(block|event|subevent):(.+)$/.exec(value ?? "");
  return match ? { kind: match[1] as JournalTeam["kind"], id: match[2] } : null;
}
export function teamLabel(team: Pick<MeritTeam, "kind" | "title">) {
  if (team.kind === "chair") return "Председатель";
  if (team.kind === "block") return team.title ? `Блок «${team.title}»` : "Блок";
  return team.title || (team.kind === "event" ? "Мероприятие" : "Подмероприятие");
}
function teamTitle(team: JournalTeam, names?: TeamNames) {
  if (team.kind === "block") return names?.blocks.find(block => block.block_id === team.id)?.name ?? null;
  if (team.kind === "event") return names?.events.find(event => event.event_id === team.id)?.title ?? null;
  if (team.kind === "subevent") return names?.subs.find(sub => sub.subevent_id === team.id)?.title ?? null;
  return null;
}
/** The teams of the records the reader sees, by name; a chosen team the records lack (a stale
 *  link) stays among them, so the select shows what the journal is filtered by. */
export function teamOptions(merits: Merit[], names: TeamNames | undefined, chosen: JournalTeam | null) {
  const teams = new Map<string, JournalTeam>();
  for (const team of [...merits.map(meritTeam), ...(chosen ? [chosen] : [])])
    if (team.kind === "chair" || team.id) teams.set(teamValue(team), team);
  return [...teams].map(([value, team]) => ({ value, label: teamLabel({ kind: team.kind, title: teamTitle(team, names) }) }))
    .sort((a, b) => a.label.localeCompare(b.label, "ru"));
}

/** «Фамилия Имя»: a journal line has no room for the patronymic. */
export const shortName = (user: Pick<UserRef, "display_name"> | null | undefined) =>
  user ? user.display_name.trim().split(/\s+/).slice(0, 2).join(" ") : "Участник";
type Recipient = { user?: UserRef; hours?: number | null; evaluation?: number | null; completed_at?: string | null };
const recipient = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Recipient : null;
const flags = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const amount = (value: unknown) => typeof value === "number" ? metricValue(value) : "—";
const moment = (value: unknown, unset = "—") => typeof value === "string" && value ? displayDate(value) : unset;
const plain = (value: unknown) => value === null || value === undefined || value === "" ? "—"
  : typeof value === "boolean" ? value ? "да" : "нет" : typeof value === "number" ? metricValue(value) : typeof value === "string" ? value : JSON.stringify(value);

/** One recorded change as short lines: «Андреев Егор — часы: 3 → 4», «Получатели: +Иванов
 *  Алексей (2 ч, оценка 1)», «Критерий «Задача уникальная»: нет → да», «Описание изменено». */
export function changeLines(change: HistoryChange): JournalLine[] {
  if (change.field === "recipients") {
    const before = recipient(change.before), after = recipient(change.after), name = shortName((after ?? before)?.user);
    if (!before && after) return [{ tone: "add", text: `Получатели: +${name} (${amount(after.hours)} ч, оценка ${amount(after.evaluation)})` }];
    if (before && !after) return [{ tone: "remove", text: `Получатели: −${name} (было ${amount(before.hours)} ч)` }];
    if (!before || !after) return [];
    const parts = [
      ...("hours" in before || "hours" in after ? [`часы: ${amount(before.hours)} → ${amount(after.hours)}`] : []),
      ...("evaluation" in before || "evaluation" in after ? [`оценка: ${amount(before.evaluation)} → ${amount(after.evaluation)}`] : []),
      ...("completed_at" in before || "completed_at" in after ? [`дата выполнения: ${moment(before.completed_at, "не задана")} → ${moment(after.completed_at, "не задана")}`] : []),
    ];
    return parts.map(part => ({ text: `${name} — ${part}` }));
  }
  const before = flags(change.before), after = flags(change.after);
  if (change.field === "criteria" && before && after) {
    const order = Object.keys(criteriaLabels);
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !!before[key] !== !!after[key])
      .sort((a, b) => (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1));
    return keys.map(key => ({ text: `Критерий «${criteriaLabels[key as keyof typeof criteriaLabels] ?? key}»: ${before[key] ? "да" : "нет"} → ${after[key] ? "да" : "нет"}` }));
  }
  if (change.field === "title") return [{ text: `Название: «${plain(change.before)}» → «${plain(change.after)}»` }];
  if (change.field === "description") return [{ text: "Описание изменено" }];
  if (change.field.endsWith("_at")) return [{ text: `${change.label}: ${moment(change.before)} → ${moment(change.after)}` }];
  return [{ text: `${change.label}: ${plain(change.before)} → ${plain(change.after)}` }];
}

const dayWithoutYear = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", weekday: "long", day: "numeric", month: "long" });
const dayWithYear = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", weekday: "long", day: "numeric", month: "long", year: "numeric" });
/** «Суббота, 7 ноября» by Moscow time; a day of another year names it. */
export function dayHeading(stamp: string, now = Date.now()) {
  const year = moscowDay(new Date(now).toISOString()).slice(0, 4);
  return capitalizeFirst((moscowDay(stamp).startsWith(year) ? dayWithoutYear : dayWithYear).format(new Date(stamp)));
}
/** The journal's items (newest first) grouped by their Moscow day. */
export function journalDays(items: MeritJournalItem[], now = Date.now()) {
  const days: { day: string; heading: string; items: MeritJournalItem[] }[] = [];
  for (const item of items) {
    const day = moscowDay(item.entry.created_at), last = days.at(-1);
    if (last?.day === day) last.items.push(item);
    else days.push({ day, heading: dayHeading(item.entry.created_at, now), items: [item] });
  }
  return days;
}
