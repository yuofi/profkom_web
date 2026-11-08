import { useEffect, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { EntityPicker, type EntityOption } from "../../components/Workspace/EntityPicker";
import { UserChip } from "../../components/Workspace/UserChip";
import { Empty, Loading, QueryState } from "../../components/Workspace/WorkspaceUI";
import type { Merit, MeritJournalItem } from "../../utils/api/contract";
import { canRetainData } from "../../utils/api/request";
import { seasonsApi } from "../../utils/api/seasons.api";
import { displayTime } from "../../utils/dates";
import { changeLines, journalDays, parseTeam, shortName, teamLabel, teamOptions, teamValue, type TeamNames } from "./meritJournalView";
import { plural } from "./seasonAnalyticsView";
import s from "../../components/Workspace/Workspace.module.css";
import u from "./SeasonWorkspace.module.css";
import j from "./MeritJournal.module.css";

export const MERIT_JOURNAL_PAGE = 30;

function JournalEntry({ item: { entry, merit } }: { item: MeritJournalItem }) {
  const lines = entry.hidden ? [] : entry.changes.flatMap(changeLines);
  return <li tabIndex={-1} data-journal-entry={entry.id}>
    <time dateTime={entry.created_at}>{displayTime(entry.created_at)}</time>
    <div><UserChip user={{ ...entry.changed_by, display_name: shortName(entry.changed_by) }} /></div>
    <div>
      <p className={j.record}><strong>{merit.title}</strong><small>{teamLabel(merit.team)}</small></p>
      {lines.length > 0
        ? <ul className={j.lines} aria-label="Что изменилось">{lines.map((line, index) => <li key={index} data-tone={line.tone}>{line.text}</li>)}</ul>
        : <p className={j.note}>{entry.hidden ? "Версия скрыта" : entry.description}</p>}
      {!entry.hidden && entry.reason && <p className={j.reason}><span>Причина:</span> {entry.reason}</p>}
    </div>
  </li>;
}

/** B9, variant В (owner 2026-11-08): every edit of the season's merit records the reader sees,
 *  newest first by Moscow day, filtered by team and participant through the URL. */
export function MeritJournal({ seasonId, merits, names, people, peopleLoading = false }: {
  seasonId: string;
  /** The records of the «Записи» view: their teams fill the team filter. */
  merits?: Merit[];
  names?: TeamNames;
  people: EntityOption[];
  peopleLoading?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const team = parseTeam(params.get("team"));
  const person = /^[1-9]\d*$/.test(params.get("person") ?? "") ? params.get("person")! : "";
  const setFilter = (name: "team" | "person", value: string) => setParams(previous => {
    const next = new URLSearchParams(previous);
    if (value) next.set(name, value);else next.delete(name);
    return next;
  }, { replace: true });
  const query = useInfiniteQuery({
    queryKey: ["history", "merits", seasonId, team ? teamValue(team) : "", person],
    queryFn: ({ pageParam, signal }) => seasonsApi.meritJournal({ season_id: seasonId, team, user_id: person ? Number(person) : null, cursor: pageParam, limit: MERIT_JOURNAL_PAGE }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.next_cursor,
    // Another team or participant keeps the season's previous list, dimmed, until its own arrives
    // (as the tracker's list does); another season starts from the loading state.
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === seasonId ? previous : undefined,
  });
  const data = !query.error || canRetainData(query.error) ? query.data : undefined;
  const items = data?.pages.flatMap(page => page.items) ?? [], shown = items.length;
  const total = data?.pages[0]?.total ?? 0, records = data?.pages[0]?.records ?? 0;
  const stale = query.isPlaceholderData;
  // As on /notifications: «Показать ещё» keeps the focus while its page loads (aria-disabled);
  // when the last page removes it, the focus moves to the first edit that page added.
  const list = useRef<HTMLDivElement>(null), more = useRef<HTMLButtonElement>(null), firstAdded = useRef<number | null>(null);
  const loadingMore = query.isFetchingNextPage || stale;
  useEffect(() => {
    const index = firstAdded.current;
    if (index === null || loadingMore) return;
    firstAdded.current = null;
    if (shown > index && !more.current && (!document.activeElement || document.activeElement === document.body))
      list.current?.querySelectorAll<HTMLElement>("[data-journal-entry]")[index]?.focus();
  }, [shown, loadingMore]);
  return <section className={u.stack} aria-label="Журнал изменений">
    <div className={j.filters}>
      <label>Команда<select name="team" value={team ? teamValue(team) : ""} onChange={event => setFilter("team", event.target.value)}>
        <option value="">Все команды</option>
        {teamOptions(merits ?? [], names, team).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <EntityPicker name="person" entity="person" label="Участник" value={person} onChange={value => setFilter("person", value)} loading={peopleLoading}
        placeholder="Все участники" options={[{ value: "", label: "Все участники" }, ...people]} />
    </div>
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!data}
      retry={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())}>
      {total > 0 && <p className={j.summary} data-stale={stale || undefined}><strong>{total}</strong> {plural(total, "изменение", "изменения", "изменений")} в <strong>{records}</strong> {plural(records, "записи", "записях", "записях")} · сначала новые</p>}
      {shown > 0 && <div ref={list} className={j.days} aria-busy={stale || undefined}>{journalDays(items).map(day => <section key={day.day} className={j.day}>
        <h2>{day.heading}</h2>
        <ol className={j.entries}>{day.items.map(item => <JournalEntry key={item.entry.id} item={item} />)}</ol>
      </section>)}</div>}
      {query.hasNextPage && <button ref={more} type="button" className={`${s.button} ${j.more}`} aria-disabled={loadingMore || undefined} aria-busy={query.isFetchingNextPage || undefined}
        onClick={() => { if (loadingMore) return;firstAdded.current = shown;void query.fetchNextPage(); }}>{query.isFetchingNextPage ? "Загружаем…" : "Показать ещё"}</button>}
      {/* An empty previous list says nothing about the new conditions: the loading line until they answer. */}
      {data && !shown && (stale ? <Loading /> : <Empty>{team || person ? "Изменений по выбранным условиям нет." : "Изменений пока нет."}</Empty>)}
    </QueryState>
  </section>;
}
