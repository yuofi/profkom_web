import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Event } from "../../utils/api/contract";
import { richText } from "../../utils/api/contract";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { getEventRoute } from "../../utils/routes";
import { moscowInput, toUtc } from "../../utils/dates";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { Empty, QueryState } from "../../components/Workspace/WorkspaceUI";
import { NEW_SERIES, chosenSeries, useSeriesField } from "./useReportSeries";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./EventEditor.module.css";
export function EventEditor({ event }: { event?: Event }) {
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const series = useSeriesField(!event);
  return <QueryState keepDataOnError={!!seasons.data} loading={seasons.isLoading} error={seasons.error} retry={() => void seasons.refetch()}>
    {seasons.data && <EventEditorBody event={event} seasons={seasons.data.items} series={series} />}
  </QueryState>;
}
function EventEditorBody({ event, seasons, series }: { event?: Event; seasons: Awaited<ReturnType<typeof seasonsApi.list>>["items"]; series: ReturnType<typeof useSeriesField> }) {
  const navigate = useNavigate(), { perform, refresh } = useWorkspaceActions();
  const available = seasons.filter(item => ["planned", "open"].includes(item.state));
  const [title, setTitle] = useState(event?.title ?? ""), [description, setDescription] = useState(event?.description.body ?? "");
  const [seasonId, setSeasonId] = useState(event?.season_id ?? available.find(item => item.is_current)?.season_id ?? available[0]?.season_id ?? "");
  const [starts, setStarts] = useState(event?.starts_at ? moscowInput(event.starts_at) : ""), [ends, setEnds] = useState(event?.ends_at ? moscowInput(event.ends_at) : "");
  const [seriesId, setSeriesId] = useState(NEW_SERIES), [saving, setSaving] = useState(false);
  const state = { title, description, seasonId, starts, ends, seriesId };const [initial] = useState(state);
  const savedState = event ? { title: event.title, description: event.description.body, seasonId: event.season_id, starts: event.starts_at ? moscowInput(event.starts_at) : "", ends: event.ends_at ? moscowInput(event.ends_at) : "", seriesId: NEW_SERIES } : initial;
  const replaceWithSaved = () => { setTitle(savedState.title);setDescription(savedState.description);setSeasonId(savedState.seasonId);setStarts(savedState.starts);setEnds(savedState.ends);setSeriesId(savedState.seriesId); };
  if (!event && !available.length) return <Empty>Для мероприятия нужен открытый или запланированный сезон.</Empty>;
  const back = event ? getEventRoute(event.event_id) : "/events";
  return <section className={s.page}>
    <header className={s.header}><nav aria-label="Навигация мероприятия"><Link to="/events">Мероприятия</Link><span>›</span><span>{event ? "Редактирование" : "Новое мероприятие"}</span></nav><div><h1>{event ? "Редактирование мероприятия" : "Новое мероприятие"}</h1><Link className={w.button} to={back}>Отмена</Link></div></header>
    <ActionForm fields={[]} revision={event?.revision} record={event ? `event:${event.event_id}` : undefined} externalState={state} savedExternalState={savedState} onReplaceWithSaved={replaceWithSaved} externalBusy={saving} allowExitSave={false}
      submitLabel={event ? "Сохранить изменения" : "Создать мероприятие"} onConflict={refresh} onSubmit={async (_, revision) => {
        if (!title.trim()) throw Error("Введите название мероприятия");
        if (starts && ends && toUtc(starts) > toUtc(ends)) throw Error("Окончание раньше начала");
        setSaving(true);
        try {
          const data = { title: title.trim(), description: richText(description), starts_at: starts ? toUtc(starts) : null, ends_at: ends ? toUtc(ends) : null };
          const saved = await perform(() => event ? eventsApi.update(event.event_id, { ...data, expected_revision: revision! }) : eventsApi.create({ title: data.title, description: data.description, season_id: seasonId, ...(data.starts_at ? { starts_at: data.starts_at } : {}), ...(data.ends_at ? { ends_at: data.ends_at } : {}), ...chosenSeries(seriesId) }));
          if (!event) navigate(getEventRoute(saved.event_id));return event ? { revision: saved.revision } : undefined;
        } finally { setSaving(false); }
      }}>
      <div className={s.workspace}><section className={s.description} aria-label="Описание мероприятия">
        <label className={`${w.field} ${s.name}`}>Название мероприятия<input name="title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Название мероприятия" required disabled={saving} /></label>
        <MarkdownEditor name="description" label="Описание мероприятия" value={description} onChange={setDescription} rows={14} draft={false} context="task" disabled={saving} />
      </section><aside className={s.parameters} aria-label="Параметры мероприятия"><h2>Параметры</h2>
        <label className={w.field}>Сезон<select name="season" value={seasonId} onChange={e => setSeasonId(e.target.value)} disabled={!!event || saving} required>{(event ? seasons.filter(item => item.season_id === event.season_id) : available).map(item => <option key={item.season_id} value={item.season_id}>{item.title}</option>)}</select></label>
        <div className={s.dates}><label className={w.field}>Начало, МСК<input name="starts" type="datetime-local" value={starts} onChange={e => setStarts(e.target.value)} disabled={saving} /></label><span aria-hidden="true">↓</span><label className={w.field}>Окончание, МСК<input name="ends" type="datetime-local" value={ends} onChange={e => setEnds(e.target.value)} disabled={saving} /></label></div>
        <p className={s.note}>Даты необязательны. Когда они известны, мероприятие появится в календаре.</p>
        {!event && <details className={s.series}><summary>История отчётов</summary><label className={w.field}>Серия отчётов<select name="series" value={seriesId} onChange={e => setSeriesId(e.target.value)} disabled={saving}>{series.options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><small>Для ежегодного мероприятия можно продолжить существующую серию.</small></details>}
      </aside></div>
    </ActionForm>
  </section>;
}
