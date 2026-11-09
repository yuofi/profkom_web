// «Записи» of «Особые заслуги и волонтёры» (owner B8, variant Г, 2026-11-09): the date, title, team and
// author once per record and a line per recipient with their own hours, evaluation and KKR; no record total.
// The search and five filters run over the season's whole list; a record opens in a window.
import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Contribution, Merit } from "../../utils/api/contract";
import type { ContactInfoOut } from "../../utils/api/types";
import { ChipAvatar, ChipInitials } from "../../components/Workspace/ChipFace";
import { HoverCard } from "../../components/Workspace/HoverCard";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { Empty, Glyph } from "../../components/Workspace/WorkspaceUI";
import { getContactRoute, getProfilePage } from "../../utils/routes";
import { useSession } from "../../utils/session";
import { shortDate } from "../../utils/dates";
import type { TeamNames } from "./meritJournalView";
import {
  activeFilters, applyFilters, buildRows, filtered, filterOptions, kkr, noFilters, num, recordDay, shareText,
  type FilterKey, type Person, type RecordFilters, type RecordRow, type Share,
} from "./meritRecordListView";
import { plural } from "./seasonAnalyticsView";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { useNarrowScreen } from "./useNarrowScreen";
import s from "../../components/Workspace/Workspace.module.css";
import uc from "../../components/Workspace/UserChip.module.css";
import v from "./MeritRecordList.module.css";

const PAGE = 20;
const kindTitles: Record<Merit["source_kind"], string> = { chair_merit: "Заслуга председателя", head_merit: "Особая заслуга на мероприятии", block_volunteer: "Волонтёрская работа блока", subevent_volunteer: "Волонтёрская работа подмероприятия" };
/** A click on a chip, a link or a button inside a row is its own action, not the row's. */
const ownAction = (target: EventTarget) => target instanceof Element && !!target.closest("a, button, [data-row-action]");

function Face({ person }: { person: Person }) {
  return <ChipAvatar src={person.photo} className={v.face} fallback={<ChipInitials name={person.full} className={v.initials} />} />;
}
/** Smaller than the site's UserChip: a 20 px face and «Фамилия И.»; the full name and the values in a
 *  card on hover and on keyboard focus, and in the link's accessible name. */
function PersonChip({ person, detail, wide = false }: { person: Person; detail: string; wide?: boolean }) {
  const { session } = useSession();
  const chip = <><Face person={person} /><span>{wide ? person.name : person.short}</span></>;
  if (person.id === null) return <span className={v.chipAnchor}><span className={v.chip} title={`${person.full} · ${detail}`}>{chip}</span></span>;
  const to = person.id === session?.user_id ? getProfilePage() : getContactRoute(person.id);
  return <HoverCard className={v.chipAnchor} content={() => <div className={uc.identity}><ChipAvatar src={person.photo} large fallback={<ChipInitials name={person.full} />} /><div><strong>{person.full}</strong><small>{detail}</small></div></div>}>
    {({ describedBy, close }) => <Link className={v.chip} to={to} aria-label={person.full} aria-describedby={describedBy} onClick={close}>{chip}</Link>}
  </HoverCard>;
}
function Score({ value }: { value: number | null }) {
  return value === null ? <span className={v.dim} title="ККР не рассчитан">—</span> : <span className={v.score} data-negative={value < 0 || undefined}>{kkr(value)}</span>;
}
function Evaluation({ value }: { value: number }) {
  return <span className={v.evaluation} data-value={value}>{num(value)}</span>;
}

/** The search, five lists of one size, «Найдено N из M записей» and «Сбросить»; on a phone the lists
 *  stand behind «Фильтры» with the number of chosen ones. */
function Toolbar({ rows, filters, set, found }: { rows: RecordRow[]; filters: RecordFilters; set: (f: RecordFilters) => void; found: number }) {
  const [open, setOpen] = useState(false);
  const narrow = useNarrowScreen();
  const options = useMemo(() => filterOptions(rows), [rows]);
  const active = activeFilters(filters);
  const list = (key: FilterKey, label: string, all: string) => <label className={v.filter}>
    <span>{label}</span>
    <select name={`records-${key}`} value={filters[key]} data-active={!!filters[key] || undefined} onChange={event => set({ ...filters, [key]: event.target.value })}>
      <option value="">{all}</option>
      {options[key].map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      {/* A choice the records no longer have (an edit removed it) stays named until it is reset. */}
      {filters[key] && !options[key].some(([value]) => value === filters[key]) && <option value={filters[key]}>Нет в записях</option>}
    </select>
  </label>;
  const total = rows.length;
  return <section className={v.toolbar} aria-label="Поиск и фильтры записей">
    <div className={v.searchRow}>
      <label className={v.search}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
        <input type="search" name="records-q" aria-label="Поиск по названию, получателю или автору" placeholder={narrow ? "Запись или человек" : "Название, получатель или автор"}
          value={filters.q} onChange={event => set({ ...filters, q: event.target.value })} />
      </label>
      <button type="button" className={`${s.button} ${v.filterToggle}`} aria-expanded={open} aria-controls="merit-record-filters" onClick={() => setOpen(value => !value)}>
        <Glyph name="filter_list" />Фильтры{active > 0 && <span className={v.badge} aria-label={`выбрано ${active}`}>{active}</span>}
      </button>
    </div>
    <div id="merit-record-filters" className={v.filters} data-open={open || undefined}>
      {list("team", "Команда", "Все команды")}
      {list("person", "Получатель", "Все получатели")}
      {list("author", "Автор", "Все авторы")}
      {list("kind", "Вид записи", "Все виды")}
      {list("month", "Месяц", "Весь сезон")}
    </div>
    <div className={v.foundLine}>
      <p role="status">{filtered(filters)
        ? <>Найдено <strong>{found}</strong> из {total} {plural(total, "записи", "записей", "записей")}</>
        : <><strong>{total}</strong> {plural(total, "запись", "записи", "записей")}</>}</p>
      {filtered(filters) && <button type="button" className={v.reset} onClick={() => set(noFilters)}>Сбросить</button>}
    </div>
  </section>;
}

/** Each recipient's values in the window: hours, evaluation, the completion date with «позже срока», KKR. */
function Recipients({ row, showKkr }: { row: RecordRow; showKkr: boolean }) {
  return <table className={v.breakdown} aria-label="Получатели и их значения">
    <thead><tr><th scope="col">Получатель</th><th scope="col" data-num>Часы</th><th scope="col" data-num>Оценка</th><th scope="col">Выполнено</th>{showKkr && <th scope="col" data-num>ККР</th>}</tr></thead>
    <tbody>{row.shares.map(x => <tr key={x.person.key}>
      <td data-cell="person"><PersonChip person={x.person} detail={shareText(x, showKkr)} wide /></td>
      <td data-num data-unit="ч">{num(x.hours)}</td>
      <td data-num data-label="оценка"><Evaluation value={x.evaluation} /></td>
      <td data-cell="done" data-empty={!x.completed || undefined}>{x.completed ? shortDate(x.completed) : <span className={v.dim}>—</span>}{x.late && <small className={v.late}>позже срока</small>}</td>
      {showKkr && <td data-num data-label="ККР"><Score value={x.score} /></td>}
    </tr>)}</tbody>
  </table>;
}

function RecordTable({ rows, showKkr, open }: { rows: RecordRow[]; showKkr: boolean; open: (id: string) => void }) {
  return <table className={v.table} data-kkr={showKkr || undefined}>
    <colgroup><col className={v.cDate} /><col /><col className={v.cWho} /><col className={v.cHours} /><col className={v.cMark} />{showKkr && <col className={v.cKkr} />}<col className={v.cAuthor} /></colgroup>
    <thead><tr><th scope="col">Дата</th><th scope="col">Запись</th><th scope="col">Получатель</th><th scope="col" data-num>Часы</th><th scope="col" data-num>Оценка</th>{showKkr && <th scope="col" data-num>ККР</th>}<th scope="col">Автор</th></tr></thead>
    {rows.map(row => {
      const id = row.merit.merit_id;
      const lines: (Share | null)[] = row.shares.length ? row.shares : [null];
      return <tbody key={id} className={v.group} data-record={id}
        onClick={(event: MouseEvent) => { if (!ownAction(event.target)) open(id); }}
        onKeyDown={(event: KeyboardEvent) => {
          // Enter on the record's title (or anything of the row but a link) opens it; a chip's link keeps its own Enter.
          if (event.key !== "Enter" || (event.target instanceof Element && event.target.closest("a, [data-row-action]"))) return;
          event.preventDefault();open(id);
        }}>
        {lines.map((x, i) => <tr key={x?.person.key ?? "none"} className={v.line} data-first={i === 0 || undefined}>
          {i === 0 && <td rowSpan={lines.length} data-cell="date">{recordDay(row.merit.assigned_at)}</td>}
          {i === 0 && <td rowSpan={lines.length} data-cell="title"><button type="button" className={v.rowTitle} aria-haspopup="dialog" onClick={() => open(id)}>{row.merit.title}</button><small>{row.team}</small></td>}
          <td data-cell="person">{x ? <PersonChip person={x.person} detail={shareText(x, showKkr)} /> : <span className={v.dim}>Нет получателей</span>}</td>
          <td data-num data-unit={x ? "ч" : undefined}>{x && num(x.hours)}</td>
          <td data-num data-label={x ? "оценка" : undefined}>{x && <Evaluation value={x.evaluation} />}</td>
          {showKkr && <td data-num data-label={x ? "ККР" : undefined}>{x && <Score value={x.score} />}</td>}
          {i === 0 && <td rowSpan={lines.length} data-cell="author"><PersonChip person={row.author} detail="Автор записи" /></td>}
        </tr>)}
      </tbody>;
    })}
  </table>;
}

export function MeritRecordList({ items, contributions, showKkr, contacts, names, details }: {
  items: Merit[];
  /** The season's merit contributions: each recipient's KKR. Only a reader of KKR has them. */
  contributions?: Contribution[];
  showKkr: boolean;
  contacts?: ContactInfoOut[];
  names?: TeamNames;
  /** The record's description, history and correction under its recipients in the window. */
  details: (merit: Merit) => ReactNode;
}) {
  const rows = useMemo(() => buildRows(items, contributions, contacts, names), [items, contributions, contacts, names]);
  const [filters, setFilters] = useState<RecordFilters>(noFilters);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const found = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  // The window keeps its record while an edit makes it leave the filters.
  const current = rows.find(row => row.merit.merit_id === open);
  const set = (next: RecordFilters) => { setFilters(next);setLimit(PAGE); };
  return <section className={v.list} aria-label="Записи">
    <Toolbar rows={rows} filters={filters} set={set} found={found.length} />
    {found.length ? <RecordTable rows={found.slice(0, limit)} showKkr={showKkr} open={setOpen} />
      : <Empty>Записей по этим условиям нет. Измените поиск или сбросьте фильтры.</Empty>}
    {found.length > limit && <div className={v.moreRow}><button type="button" className={s.button} onClick={() => setLimit(limit + PAGE)}>Показать ещё · {Math.min(PAGE, found.length - limit)}</button></div>}
    {current && <UnsavedChangesScope><TrackerTaskDialog className={v.dialog} title={current.merit.title} onClose={() => setOpen(null)}>
      <div className={v.meta}>
        <p>{current.team} · {kindTitles[current.merit.source_kind]}</p>
        <p>Выдано {shortDate(current.merit.assigned_at)} · срок {shortDate(current.merit.deadline_at)} · записал(а) {current.author.name}, {shortDate(current.merit.created_at)}</p>
      </div>
      {current.shares.length > 0 && <Recipients row={current} showKkr={showKkr} />}
      <div className={v.details}>{details(current.merit)}</div>
    </TrackerTaskDialog></UnsavedChangesScope>}
  </section>;
}
