import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { seasonsApi } from "../../utils/api/seasons.api";
import type { Season } from "../../utils/api/contract";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { displayDate, moscowInput, toUtc } from "../../utils/dates";
import { getSeasonRoute } from "../../utils/routes";
import { Glyph } from "../../components/Workspace/WorkspaceUI";
import u from "./SeasonWorkspace.module.css";

const types = { winter_spring: "Зима — весна", summer_autumn: "Лето — осень", autumn_winter: "Осень — зима" };
export function SeasonEditor({ season, onClose }: { season?: Season; onClose?: () => void }) {
  const navigate = useNavigate(), leave = useGuardedAction(), { perform, refresh } = useWorkspaceActions();
  const [title, setTitle] = useState(season?.title ?? ""), [type, setType] = useState<Season["type"]>(season?.type ?? "autumn_winter");
  const [starts, setStarts] = useState(season ? moscowInput(season.starts_at) : ""), [ends, setEnds] = useState(season ? moscowInput(season.ends_at) : ""), [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const external = { title, type, starts, ends, reason };const [initial] = useState(external);
  const savedState = season ? { title: season.title, type: season.type, starts: moscowInput(season.starts_at), ends: moscowInput(season.ends_at), reason: "" } : initial;
  const replace = () => { setTitle(savedState.title);setType(savedState.type);setStarts(savedState.starts);setEnds(savedState.ends);setReason(savedState.reason); };
  const cancel = () => { if (onClose) leave(onClose);else navigate("/seasons"); };
  return <section className={u.page}>
    <header className={u.header}><div><nav className={u.breadcrumbs} aria-label="Путь редактора сезона"><Link to="/seasons">Сезоны</Link><span>›</span><span>{season ? "Редактирование сезона" : "Новый сезон"}</span></nav><h1>{season ? "Редактировать сезон" : "Новый сезон"}</h1><p className={u.subtitle}>{season ? "Название и период сезона. Изменения сохраняются с основанием." : "Сначала задайте название и даты. Открыть сезон можно после создания."}</p></div><button type="button" className={u.secondary} disabled={saving} onClick={cancel}>Отмена</button></header>
    <ActionForm fields={[]} revision={season?.revision} record={season ? `season:${season.season_id}` : undefined} externalState={external} savedExternalState={savedState} onReplaceWithSaved={replace} externalBusy={saving} allowExitSave={!!season} submitLabel={season ? "Сохранить сезон" : "Создать сезон"} onConflict={refresh} onSubmit={async (_, revision) => {
      if (!title.trim()) throw Error("Введите название сезона");if (!starts || !ends) throw Error("Укажите начало и окончание сезона");
      const start = toUtc(starts), end = toUtc(ends);if (Date.parse(start) >= Date.parse(end)) throw Error("Начало должно быть раньше конца");
      if (season && !reason.trim()) throw Error("Укажите основание изменения сезона");
      setSaving(true);
      try {
        const saved = await perform(() => season ? seasonsApi.update(season.season_id, { expected_revision: revision!, title: title.trim(), starts_at: start, ends_at: end, reason: reason.trim() }) : seasonsApi.create({ title: title.trim(), type, starts_at: start, ends_at: end }));
        if (onClose) onClose();else navigate(getSeasonRoute(saved.season_id));return saved;
      } finally { setSaving(false); }
    }}>
      <div className={u.editorCanvas}>
        <div className={u.editorMain}>
          <label className={u.editorTitle}>Название сезона<input name="title" autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="Например, Осень — зима 2026" maxLength={200} required disabled={saving} /></label>
          <section className={u.editorPeriod} aria-label="Период сезона"><label className={u.editorField}>Начало, МСК<input name="start" type="datetime-local" value={starts} onChange={e => setStarts(e.target.value)} required disabled={saving} /></label><span aria-hidden="true">→</span><label className={u.editorField}>Окончание, МСК<input name="end" type="datetime-local" value={ends} onChange={e => setEnds(e.target.value)} required disabled={saving} /></label></section>
          <section className={u.editorPreview} aria-label="Предпросмотр сезона"><span className={u.eyebrow}>Так сезон увидят участники</span><strong>{title.trim() || "Название сезона"}</strong><p>{starts ? previewDate(starts) : "Дата начала"} — {ends ? previewDate(ends) : "Дата окончания"}</p><span>{types[type]}</span></section>
          {season && <label className={u.editorField}>Основание изменения<textarea name="reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="Что и почему нужно исправить" required disabled={saving} /></label>}
        </div>
        <aside className={u.editorAside} aria-label="Параметры сезона"><h2>Параметры</h2><label className={u.editorField}>Тип сезона{season ? <span>{types[type]}</span> : <select aria-label="Тип сезона" name="type" value={type} onChange={e => setType(e.target.value as Season["type"])} disabled={saving}>{Object.entries(types).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</label><p className={u.editorFootnote}><Glyph name="calendar_month" /> Даты заданы по московскому времени.</p><p className={u.editorFootnote}>{season ? "Изменение периода не переносит задачи и мероприятия между сезонами." : "Новый сезон появится как запланированный. Текущий сезон продолжит работать до вашего отдельного решения."}</p></aside>
      </div>
    </ActionForm>
  </section>;
}

function previewDate(value: string) { try { return displayDate(toUtc(value)); } catch { return "Проверьте дату"; } }
