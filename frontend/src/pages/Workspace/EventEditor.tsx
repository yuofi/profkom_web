import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Event, Subevent, Season } from "../../utils/api/contract";
import { richText } from "../../utils/api/contract";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { getEventRoute, getSubeventRoute } from "../../utils/routes";
import { moscowInput, toUtc } from "../../utils/dates";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { SectionHomeLink } from "../../components/Workspace/SectionHomeLink";
import { Empty, QueryState } from "../../components/Workspace/WorkspaceUI";
import { NEW_SERIES, chosenSeries, useSeriesField } from "./useReportSeries";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./EventEditor.module.css";
import { outsideParentPeriod } from "./eventDates";

export function EventEditor({ event }: { event?: Event }) {
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const series = useSeriesField(!event);
  return <QueryState keepDataOnError={!!seasons.data} loading={seasons.isLoading} error={seasons.error} retry={() => void seasons.refetch()}>
    {seasons.data && <EventCanvas event={event} seasons={seasons.data.items} series={series} />}
  </QueryState>;
}
export function SubeventEditor({ parent, subevent, onClose }: { parent: Event; subevent?: Subevent; onClose: () => void }) {
  const series = useSeriesField(!subevent, parent);
  return <EventCanvas parent={parent} subevent={subevent} seasons={[]} series={series} onClose={onClose} />;
}
function EventCanvas({ event, subevent, parent, seasons, series, onClose }: {
  event?: Event; subevent?: Subevent; parent?: Event; seasons: Season[]; series: ReturnType<typeof useSeriesField>; onClose?: () => void;
}) {
  const navigate = useNavigate(), { perform, refresh } = useWorkspaceActions(), leave = useGuardedAction();
  const existing = subevent ?? event, child = !!parent;
  const available = seasons.filter(item => ["planned", "open"].includes(item.state));
  const [title, setTitle] = useState(existing?.title ?? ""), [description, setDescription] = useState(existing?.description.body ?? "");
  const [announcement, setAnnouncement] = useState(subevent?.announcement?.body ?? "");
  const [seasonId, setSeasonId] = useState(event?.season_id ?? parent?.season_id ?? available.find(item => item.is_current)?.season_id ?? available[0]?.season_id ?? "");
  const [allDay, setAllDay] = useState(existing?.all_day ?? false);
  const input = (value?: string | null, day = allDay) => value ? moscowInput(value).slice(0, day ? 10 : 16) : "";
  const [starts, setStarts] = useState(input(existing?.starts_at)), [ends, setEnds] = useState(input(existing?.ends_at));
  const [seriesId, setSeriesId] = useState(NEW_SERIES), [saving, setSaving] = useState(false);
  const state = { title, description, announcement, seasonId, starts, ends, allDay, seriesId }, [initial] = useState(state);
  const savedState = existing ? { title: existing.title, description: existing.description.body, announcement: subevent?.announcement?.body ?? "", seasonId: event?.season_id ?? parent!.season_id, starts: input(existing.starts_at, existing.all_day), ends: input(existing.ends_at, existing.all_day), allDay: existing.all_day ?? false, seriesId: NEW_SERIES } : initial;
  const replace = () => { setTitle(savedState.title);setDescription(savedState.description);setAnnouncement(savedState.announcement);setSeasonId(savedState.seasonId);setStarts(savedState.starts);setEnds(savedState.ends);setAllDay(savedState.allDay);setSeriesId(savedState.seriesId); };
  const utc = (value: string) => value ? toUtc(allDay ? `${value}T00:00` : value) : null;
  const outside = parent && outsideParentPeriod({ starts_at: utc(starts), ends_at: utc(ends), all_day: allDay }, parent);
  if (!child && !event && !available.length) return <Empty>Для мероприятия нужен открытый или запланированный сезон.</Empty>;
  const heading = existing ? `Редактирование ${child ? "подмероприятия" : "мероприятия"}` : `Новое ${child ? "подмероприятие" : "мероприятие"}`;
  const back = event ? getEventRoute(event.event_id) : subevent ? getSubeventRoute(subevent.subevent_id) : parent ? getEventRoute(parent.event_id) : "/events";
  return <section className={s.page}>
    <BrandedHeader className={s.canvasHeader}><div><SectionHomeLink to="/events" label="Мероприятия" /><nav aria-label="Навигация мероприятия"><Link to={parent ? getEventRoute(parent.event_id) : "/events"}>{parent?.title ?? "Мероприятия"}</Link><span>›</span><span>{heading}</span></nav><h1 className={w.title}>{heading}</h1></div>{onClose ? <button type="button" className={w.button} onClick={() => leave(onClose)}>Отмена</button> : <Link className={w.button} to={back}>Отмена</Link>}</BrandedHeader>
    <ActionForm fields={[]} revision={existing?.revision} record={existing ? `${child ? "subevent" : "event"}:${subevent?.subevent_id ?? event?.event_id}` : undefined} externalState={state} savedExternalState={savedState} onReplaceWithSaved={replace} externalBusy={saving} allowExitSave={false}
      submitLabel={existing ? "Сохранить изменения" : child ? "Создать подмероприятие" : "Создать мероприятие"} onConflict={refresh} onSubmit={async (_, revision) => {
        if (!title.trim()) throw Error("Введите название мероприятия");
        if (starts && ends && utc(starts)! > utc(ends)!) throw Error("Окончание раньше начала");
        setSaving(true);
        try {
          const data = { title: title.trim(), description: richText(description), starts_at: utc(starts), ends_at: utc(ends), all_day: allDay };
          const patch = { title: data.title, description: data.description, ...(starts !== savedState.starts ? { starts_at: data.starts_at } : {}), ...(ends !== savedState.ends ? { ends_at: data.ends_at } : {}), ...(allDay !== savedState.allDay ? { all_day: data.all_day } : {}) };
          if (parent) {
            const body = { ...(subevent ? patch : data), announcement: richText(announcement) };
            const saved = await perform(() => subevent ? eventsApi.updateSubevent(subevent.subevent_id, { ...body, expected_revision: revision! }) : eventsApi.createSubevent(parent.event_id, { ...body, ...chosenSeries(seriesId) }));
            if (!subevent) navigate(getSubeventRoute(saved.subevent_id));
            onClose?.();return subevent ? { revision: saved.revision } : undefined;
          }
          const saved = await perform(() => event ? eventsApi.update(event.event_id, { ...patch, expected_revision: revision! }) : eventsApi.create({ title: data.title, description: data.description, season_id: seasonId, all_day: allDay, ...(data.starts_at ? { starts_at: data.starts_at } : {}), ...(data.ends_at ? { ends_at: data.ends_at } : {}), ...chosenSeries(seriesId) }));
          if (!event) navigate(getEventRoute(saved.event_id));return event ? { revision: saved.revision } : undefined;
        } finally { setSaving(false); }
      }}>
      <div className={s.workspace}><section className={s.description} aria-label="Описание мероприятия">
        <label className={`${w.field} ${s.name}`}>Название мероприятия<input name="title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Название мероприятия" required disabled={saving} /></label>
        {child && <><MarkdownEditor name="announcement" label="Анонс для всех активистов" value={announcement} onChange={setAnnouncement} rows={7} draft={false} context="task" disabled={saving} /><p className={s.note}>Анонс, даты и состав команды видят все одобренные пользователи. Рабочие данные остаются доступны команде.</p></>}
        <MarkdownEditor name="description" label={child ? "Рабочее описание для команды" : "Описание мероприятия"} value={description} onChange={setDescription} rows={child ? 9 : 14} draft={false} context="task" disabled={saving} />
      </section><aside className={s.parameters} aria-label="Параметры мероприятия"><h2>Параметры</h2>
        {parent ? <p>{parent.title}</p> : <label className={w.field}>Сезон<select name="season" value={seasonId} onChange={e => setSeasonId(e.target.value)} disabled={!!event || saving} required>{(event ? seasons.filter(item => item.season_id === event.season_id) : available).map(item => <option key={item.season_id} value={item.season_id}>{item.title}</option>)}</select></label>}
        <label className={s.check}><input type="checkbox" checked={allDay} disabled={saving} onChange={e => { const checked = e.target.checked;setAllDay(checked);setStarts(starts ? checked ? starts.slice(0, 10) : `${starts.slice(0, 10)}T00:00` : "");setEnds(ends ? checked ? ends.slice(0, 10) : `${ends.slice(0, 10)}T00:00` : ""); }} />Целый день</label>
        <div className={s.dates}><label className={w.field}>Начало{!allDay && ", МСК"}<input name="starts" type={allDay ? "date" : "datetime-local"} value={starts} onChange={e => setStarts(e.target.value)} disabled={saving} /></label><span aria-hidden="true">↓</span><label className={w.field}>Окончание{!allDay && ", МСК"}<input name="ends" type={allDay ? "date" : "datetime-local"} value={ends} onChange={e => setEnds(e.target.value)} disabled={saving} /></label></div>
        <p className={s.note}>Даты необязательны. Конечная дата целого дня включена в период.</p>
        {outside && <p className={s.warning} role="status">Даты выходят за период главного мероприятия. Сохранение разрешено.</p>}
        {!existing && <details className={s.series}><summary>История отчётов</summary><label className={w.field}>Серия отчётов<select name="series" value={seriesId} onChange={e => setSeriesId(e.target.value)} disabled={saving}>{series.options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><small>Можно продолжить существующую серию отчётов.</small></details>}
      </aside></div>
    </ActionForm>
  </section>;
}
