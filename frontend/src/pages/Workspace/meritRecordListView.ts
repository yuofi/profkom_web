/** The records of «Особые заслуги и волонтёры» (owner B8, variant Г, 2026-11-09) in words and numbers:
 *  every recipient with their own hours, evaluation and KKR (a record has no total of its own), the
 *  search and the five filters. GET /merits returns the season's whole readable list, so they run here. */
import type { Contribution, Merit } from "../../utils/api/contract";
import type { ContactInfoOut } from "../../utils/api/types";
import { capitalizeFirst, moscowDay } from "../../utils/calendar";
import { meritTeam, teamLabel, teamTitle, teamValue, type TeamNames } from "./meritJournalView";
import { metricValue } from "./seasonAnalyticsView";

export type MeritKind = Merit["source_kind"];
/** `key` tells people apart in the filters; a former account without an id is keyed by its name. */
export interface Person { key: string; id: number | null; full: string; name: string; short: string; photo: string | null }
export interface Share { person: Person; hours: number; evaluation: number; completed: string | null; late: boolean; score: number | null }
export interface RecordRow { merit: Merit; team: string; teamKey: string; author: Person; shares: Share[]; month: string }
export interface RecordFilters { q: string; team: string; person: string; author: string; kind: string; month: string }
export const filterKeys = ["team", "person", "author", "kind", "month"] as const;
export type FilterKey = (typeof filterKeys)[number];
export const noFilters: RecordFilters = { q: "", team: "", person: "", author: "", kind: "", month: "" };
/** The four kinds of a record, as the kind filter lists them. */
export const kindNames: Record<MeritKind, string> = { chair_merit: "Заслуги председателя", head_merit: "Заслуги главоргов", block_volunteer: "Волонтёры блоков", subevent_volunteer: "Волонтёры мероприятий" };
export const meritKinds = Object.keys(kindNames) as MeritKind[];

/** «−» before a negative number: hours and evaluations as the rest of the site prints them. */
export const num = (value: number) => metricValue(value).replace(/^-/, "−");
const kkrFormat = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** KKR always with two decimals and a comma, so a column reads evenly: «4,50», «−3,20». */
export const kkr = (value: number) => kkrFormat.format(value).replace(/^-/, "−");
/** Whole hundredths, half away from zero, never «−0». */
const hundredths = (value: number) => (Math.sign(value) * Math.round(Math.abs(value) * 100) || 0) / 100;

const DEFAULT_AVATAR = "/avatars/default.svg";
function personOf(id: number | null, contacts: Map<number, ContactInfoOut>, ref?: { display_name: string; avatar_url?: string | null }): Person {
  const contact = id === null ? undefined : contacts.get(id);
  const parts = contact ? [contact.surname, contact.name, contact.patronymic ?? ""] : (ref?.display_name ?? `Участник #${id}`).trim().split(/\s+/);
  const [surname = "", name = ""] = parts;
  const photo = (contact?.photo_url ?? ref?.avatar_url) || null;
  const full = parts.filter(Boolean).join(" ");
  // «Участник 12» or «Обезличенный участник» is not a surname and a name: it stays whole.
  const named = !!name && (!!contact || (id !== null && /^\p{Lu}/u.test(name)));
  return {
    key: id === null ? `name:${full}` : String(id), id, full,
    name: [surname, name].filter(Boolean).join(" "),
    short: named ? `${surname} ${name.charAt(0)}.` : contact ? surname || full : full,
    photo: photo && photo !== DEFAULT_AVATAR ? photo : null,
  };
}
/** The record's team by name, as the season journal names it. */
export function teamOf(merit: Merit, names?: TeamNames) {
  const team = meritTeam(merit);
  return { key: teamValue(team), name: teamLabel({ kind: team.kind, title: teamTitle(team, names) }) };
}
/** Newest work first; each recipient with their KKR from the season's contributions (null when unknown). */
export function buildRows(items: Merit[], contributions: Contribution[] | undefined, contacts: ContactInfoOut[] | undefined, names?: TeamNames): RecordRow[] {
  const known = new Map((contacts ?? []).map(contact => [contact.user_id, contact]));
  const scores = new Map<string, number | null>();
  for (const c of contributions ?? []) if (c.merit_id && c.user.user_id !== null) scores.set(`${c.merit_id}:${c.user.user_id}`, c.score === null ? null : hundredths(c.score));
  return [...items].sort((a, b) => b.assigned_at.localeCompare(a.assigned_at) || b.created_at.localeCompare(a.created_at)).map(merit => {
    const team = teamOf(merit, names);
    return {
      merit, team: team.name, teamKey: team.key, month: moscowDay(merit.assigned_at).slice(0, 7),
      author: personOf(merit.created_by.user_id, known, merit.created_by),
      shares: merit.recipients.map(r => ({
        person: personOf(r.user_id, known), hours: r.hours, evaluation: r.evaluation, completed: r.completed_at,
        late: !!r.completed_at && Date.parse(r.completed_at) > Date.parse(merit.deadline_at),
        score: scores.get(`${merit.merit_id}:${r.user_id}`) ?? null,
      })),
    };
  });
}
const words = (text: string) => text.toLocaleLowerCase("ru").replace(/ё/g, "е");
/** Every word of the search in the title, a recipient or the author; every chosen filter at once. */
export function applyFilters(rows: RecordRow[], f: RecordFilters) {
  const query = words(f.q).split(/\s+/).filter(Boolean);
  return rows.filter(row => (!f.team || row.teamKey === f.team) && (!f.kind || row.merit.source_kind === f.kind) && (!f.month || row.month === f.month)
    && (!f.author || row.author.key === f.author) && (!f.person || row.shares.some(x => x.person.key === f.person))
    && (!query.length || ((text) => query.every(word => text.includes(word)))(words([row.merit.title, row.author.full, ...row.shares.map(x => x.person.full)].join(" ")))));
}
export const activeFilters = (f: RecordFilters) => filterKeys.filter(key => f[key]).length;
export const filtered = (f: RecordFilters) => activeFilters(f) > 0 || !!f.q.trim();

const monthName = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", month: "long", year: "numeric" });
/** «Ноябрь 2026» for «2026-11». */
export const monthLabel = (key: string) => capitalizeFirst(monthName.format(new Date(`${key}-15T12:00:00Z`)).replace(/\s*г\.$/, ""));
type Option = [value: string, label: string];
/** The choices of the five filters from the records themselves: the chair, blocks, events and subevents,
 *  people by name, the kinds in their order, the months newest first. */
export function filterOptions(rows: RecordRow[]) {
  const teams = new Map<string, string>(), persons = new Map<string, string>(), authors = new Map<string, string>(), kinds = new Set<string>(), months = new Set<string>();
  for (const row of rows) {
    teams.set(row.teamKey, row.team);
    authors.set(row.author.key, row.author.name);
    kinds.add(row.merit.source_kind);
    months.add(row.month);
    for (const x of row.shares) persons.set(x.person.key, x.person.name);
  }
  const byText = (a: Option, b: Option) => a[1].localeCompare(b[1], "ru");
  const rank = (key: string) => ["chair", "block", "event", "subevent"].indexOf(key.split(":")[0]);
  return {
    team: [...teams].sort((a, b) => rank(a[0]) - rank(b[0]) || byText(a, b)),
    person: [...persons].sort(byText),
    author: [...authors].sort(byText),
    kind: meritKinds.filter(kind => kinds.has(kind)).map((kind): Option => [kind, kindNames[kind]]),
    month: [...months].sort().reverse().map((key): Option => [key, monthLabel(key)]),
  } satisfies Record<FilterKey, Option[]>;
}

const dayMonth = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", year: "numeric" });
/** «9 нояб.» this Moscow year, «9 нояб. 2025 г.» another one. */
export const recordDay = (stamp: string, now = Date.now()) =>
  (moscowDay(stamp).slice(0, 4) === moscowDay(new Date(now).toISOString()).slice(0, 4) ? dayMonth : dayMonthYear).format(new Date(stamp)).replace(/ /g, "\u00a0");
/** A recipient's values in one line, for the chip's card: «3 ч · оценка 1,5 · ККР 4,50». */
export const shareText = (x: Share, showKkr: boolean) =>
  `${num(x.hours)} ч · оценка ${num(x.evaluation)}${showKkr ? ` · ККР ${x.score === null ? "—" : kkr(x.score)}` : ""}`;
