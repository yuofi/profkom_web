import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { FormikProps } from "formik";
import { emptyCriteria } from "../../utils/api/contract";
import { profileFeaturesApi, type FeatureScope, type FeaturesContext, type KkrTemplate, type TemplateSelection, type TemplateValues } from "../../utils/api/profileFeatures.api";
import { ApiError, canRetainData, normalizeApiError } from "../../utils/api/request";
import { templateRefused, useFittingTemplates, type TemplateTarget } from "../../utils/kkrTemplates";
import { userMessage } from "../../utils/api/messages";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm, type Field } from "./ActionForm";
import { AnchoredPopover } from "./AnchoredPopover";
import { UnsavedChangesScope } from "./UnsavedChanges";
import { useGuardedAction } from "./unsavedChangesHooks";
import { EntityPicker } from "./EntityPicker";
import { selectedContent } from "./selectedContent";
import { text, number, type Values } from "./formValues";
import { Card, Empty, QueryState } from "./WorkspaceUI";
import { UserChip } from "./UserChip";
import { evaluationOptions } from "../../utils/evaluations";
import { metricValue } from "../../pages/Workspace/seasonAnalyticsView";
import { criteriaFromValues, criteriaKeys, criteriaLabels } from "../../utils/kkrCriteria";
import s from "./ProfileFeatures.module.css";
import w from "./Workspace.module.css";
import l from "./WorkspaceLayout.module.css";
const emptyValues = (): TemplateValues => ({ title: "", description: "", hours: 0, evaluation: 1, criteria: emptyCriteria() });
type EditorChoice = { template?: KkrTemplate; values: TemplateValues };
const scopeKinds = { block: "Блок", event: "Мероприятие", subevent: "Подмероприятие", global: "Весь Профком" } as const;
/** Team scopes as searchable picker options, blocks first, then events and their subevents. */
function scopeOptions(scopes: FeaturesContext["template_scopes"]) {
  const order = ["block", "event", "subevent", "global"];
  return scopes.map((scope, index) => ({ scope, index }))
    .sort((a, b) => order.indexOf(a.scope.kind) - order.indexOf(b.scope.kind) || a.scope.name.localeCompare(b.scope.name, "ru"))
    .map(({ scope, index }) => ({ value: String(index), label: `${scopeKinds[scope.kind]}: ${scope.name}`, scope: { kind: scope.kind === "global" ? "chair" as const : scope.kind, name: scope.name } }));
}
export function KkrTemplateLibrary({ initialValues, embedded = false }: { initialValues?: TemplateValues; embedded?: boolean }) {
  const query = useQuery({ queryKey: ["kkrTemplates"], queryFn: profileFeaturesApi.templates });
  const context = useQuery({ queryKey: ["profileFeaturesContext"], queryFn: profileFeaturesApi.context });
  const data = !query.error || canRetainData(query.error) ? query.data : undefined;
  const ctx = !context.error || canRetainData(context.error) ? context.data : undefined;
  const content = <QueryState loading={query.isLoading || context.isLoading} error={query.error || context.error} keepDataOnError={!!data && !!ctx}>
    {data && ctx && (embedded ? <LibraryEditor templates={data.items} context={ctx} initialValues={initialValues} /> : <UnsavedChangesScope><LibraryEditor templates={data.items} context={ctx} initialValues={initialValues} /></UnsavedChangesScope>)}
  </QueryState>;
  return embedded ? content : <Card title="Шаблоны ККР"><p>Личные и командные заготовки выполненной работы и оценивания. Применение заполняет редактор, сохранение остаётся явным.</p>{content}</Card>;
}
function LibraryEditor({ templates, context, initialValues }: { templates: KkrTemplate[]; context: FeaturesContext; initialValues?: TemplateValues }) {
  const [editing, setEditing] = useState<EditorChoice | null>(null), [generation, setGeneration] = useState(0), [created, setCreated] = useState("");
  const leave = useGuardedAction(), { perform, refresh } = useWorkspaceActions();
  const template = editing?.template;
  const choose = (next: EditorChoice) => leave(() => { setCreated("");setEditing(next);setGeneration(value => value + 1); });
  const opened = useRef<HTMLElement>(null);
  // An opened form is brought into view with its first field focused: in its card or at the top (B5).
  useEffect(() => {
    if (!generation || !opened.current) return;
    opened.current.scrollIntoView?.({ block: "nearest" });
    opened.current.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")?.focus({ preventScroll: true });
  }, [generation]);
  const values = editing?.values;
  const fields: Field[] = values ? [
    { name: "title", label: "Название работы / шаблона", value: values.title, required: true },
    { name: "body", label: "Описание работы", value: values.description, type: "textarea" },
    { name: "hours", label: "Часы", type: "number", min: 0, required: true, compact: "values", value: String(values.hours) },
    { name: "evaluation", label: "Оценка", type: "select", required: true, compact: "values", value: String(values.evaluation), options: evaluationOptions },
    ...criteriaKeys.map(name => ({ name, label: criteriaLabels[name], type: "checkbox" as const, compact: "criteria", value: String(values.criteria[name]) })),
    ...(template ? [{ name: "archived", label: "Состояние шаблона", type: "select" as const, value: String(template.archived), options: [{ value: "false", label: "Активен" }, { value: "true", label: "В архиве" }] }] : [{ name: "visibility", label: "Кому доступен шаблон", type: "select" as const, required: true, value: "personal", options: [
      ...(context.can_create_personal_template ? [{ value: "personal", label: "Только мне" }] : []),
      ...scopeOptions(context.template_scopes),
    ] }]),
  ] : [];
  const editor = editing && <section ref={opened} className={s.templateEditor} aria-label={template ? "Изменение шаблона ККР" : "Новый шаблон ККР"}>
    <div className={s.templateEditorHeader}><h3>{template ? "Изменение шаблона" : "Новый шаблон ККР"}</h3><button type="button" className={w.button} onClick={() => leave(() => setEditing(null))}>Закрыть</button></div>
    {template && <Authorship template={template} />}
    <ActionForm key={generation} revision={template?.revision} onConflict={refresh} fields={fields} submitLabel="Сохранить шаблон"
      onSubmit={async (draft, revision) => {
        const data: TemplateValues = { title: text(draft, "title"), description: text(draft, "body"), hours: number(draft, "hours"), evaluation: number(draft, "evaluation") as TemplateValues["evaluation"], criteria: { ...emptyCriteria(), ...criteriaFromValues(draft) } };
        const selected = text(draft, "visibility"), scope = context.template_scopes[Number(selected)];
        if (!template && selected !== "personal" && !scope) throw Error("Выберите область шаблона");
        const saved = await perform(() => template
          ? profileFeaturesApi.updateTemplate({ ...template, revision: revision! }, data, text(draft, "archived") === "true")
          : profileFeaturesApi.createTemplate({ visibility: selected === "personal" ? "personal" : "team", ...(selected !== "personal" ? { scope_kind: scope.kind, scope_id: scope.id } : {}), values: data }));
        // A new template closes its editor with a status: the same form must not turn into the edit form of another revision.
        if (!template) { setEditing(null);setCreated(saved.values.title);return { revision: saved.revision }; }
        setEditing({ template: saved, values: saved.values });return { revision: saved.revision };
      }} />
  </section>;
  const [filter, setFilter] = useState<LibraryFilter>(noFilter);
  // The template being edited stays in its place whatever the filters say.
  const shown = templates.filter(row => row.template_id === template?.template_id || matches(row, filter));
  // A new template or a copy opens as a card at the top; a template is edited in its own card.
  return <div className={s.library}>
    {context.can_create_personal_template && <div className={w.row}><button type="button" className={w.button} onClick={() => choose({ values: initialValues ?? emptyValues() })}>Создать шаблон ККР</button></div>}
    {created && <p role="status" className={w.success}>Шаблон создан: {created}</p>}
    {editing && !template && editor}
    {templates.length > 0 && <LibraryFilters templates={templates} value={filter} onChange={setFilter} />}
    {!templates.length && !editing && <Empty>Пока нет доступных шаблонов.</Empty>}
    {templates.length > 0 && !shown.length && <Empty>Нет шаблонов по этим условиям.</Empty>}
    {shown.map(row => row.template_id === template?.template_id ? <div key={row.template_id}>{editor}</div> : <div className={s.badge} key={row.template_id}><strong>{row.values.title}</strong><span>{row.visibility === "personal" ? "Личный" : templateOwner(row)} · {row.archived ? "В архиве" : `${metricValue(row.values.hours)} ч · оценка ${metricValue(row.values.evaluation)}`}</span><Authorship template={row} /><div className={w.row}>
      <button type="button" className={w.button} onClick={() => choose({ template: row, values: row.values })}>Изменить шаблон</button>
      {context.can_create_personal_template && <button type="button" className={w.button} onClick={() => choose({ values: { ...row.values, title: `${row.values.title} · копия` } })}>Копировать</button>}
    </div></div>)}
  </div>;
}

/** The library's own filters (B4): on the loaded list, nothing is asked of the server. */
interface LibraryFilter { search: string; team: string; kind: "" | "personal" | "team"; archived: boolean }
const noFilter: LibraryFilter = { search: "", team: "", kind: "", archived: false };
const folded = (value: string) => value.toLocaleLowerCase("ru").replaceAll("ё", "е");
const teamKey = (row: KkrTemplate) => row.scope ? `${row.scope.kind}:${row.scope.id ?? ""}` : "";
function matches(row: KkrTemplate, filter: LibraryFilter) {
  const search = folded(filter.search.trim());
  return (filter.archived || !row.archived)
    && (!filter.kind || row.visibility === filter.kind)
    && (!filter.team || (row.visibility === "team" && teamKey(row) === filter.team))
    && (!search || folded(`${row.values.title} ${row.values.description}`).includes(search));
}
const teamGroups = [["block", "Блоки"], ["event", "Мероприятия"], ["subevent", "Подмероприятия"]] as const;
function LibraryFilters({ templates, value, onChange }: { templates: KkrTemplate[]; value: LibraryFilter; onChange: (value: LibraryFilter) => void }) {
  const teams = new Map<string, FeatureScope>();
  for (const row of templates) if (row.visibility === "team" && row.scope) teams.set(teamKey(row), row.scope);
  const options = (kind: FeatureScope["kind"]) => [...teams].filter(([, scope]) => scope.kind === kind).sort((a, b) => a[1].name.localeCompare(b[1].name, "ru"))
    .map(([key, scope]) => <option key={key} value={key}>{kind === "global" ? "Весь Профком" : scope.name}</option>);
  const chosen = teams.get(value.team);
  const set = (next: Partial<LibraryFilter>) => onChange({ ...value, ...next });
  // The two lists are one pair of equal fields, on the page and in the 480 px window alike (owner 2026-11-08, item 9).
  // A team is named by itself under the group of its kind, so a long name is not hidden behind «Подмероприятие:».
  return <div className={s.libraryFilters} role="group" aria-label="Фильтры шаблонов">
    <label className={`${w.field} ${s.librarySearch}`}>Поиск<input type="search" value={value.search} placeholder="Название или описание" onChange={event => set({ search: event.target.value })} /></label>
    <div className={s.listFilters}>
      <label className={`${w.field} ${s.listFilter}`}>Команда<select ref={selectedContent} value={value.team} title={chosen && chosen.kind !== "global" ? `${scopeKinds[chosen.kind]}: ${chosen.name}` : undefined} onChange={event => set({ team: event.target.value })}>
        <option value="">Все команды</option>{options("global")}
        {teamGroups.map(([kind, label]) => { const group = options(kind);return group.length > 0 && <optgroup key={kind} label={label}>{group}</optgroup>; })}
      </select></label>
      <label className={`${w.field} ${s.listFilter}`}>Вид<select ref={selectedContent} value={value.kind} onChange={event => set({ kind: event.target.value as LibraryFilter["kind"] })}><option value="">Все виды</option><option value="personal">Личные</option><option value="team">Командные</option></select></label>
    </div>
    <div className={`${w.field} ${w.checkField} ${s.archivedFilter}`}><label className={w.check}><input type="checkbox" checked={value.archived} onChange={event => set({ archived: event.target.checked })} />Показать архивные</label></div>
  </div>;
}

/** Whose template it is, in a picker label. */
const templateOwner = (row: KkrTemplate) => row.visibility === "personal" ? "личный" : row.scope?.kind === "global" ? "Весь Профком" : row.scope?.name;

/** Who made the template and who saved it last (B2, owner 2026-11-08); no creation date. */
function Authorship({ template }: { template: KkrTemplate }) {
  return <p className={s.authorship}><span>Автор</span><UserChip user={template.author} />
    {template.revision > 1 && <><span>Изменил(а)</span><UserChip user={template.updated_by} /></>}</p>;
}

/** The template's values in this Formik draft; dates, recipients and reasons stay as they are. */
function applyTemplate(form: FormikProps<Values>, mode: "merit" | "assessment", prepared: TemplateValues) {
  const next = { ...form.values };
  if (mode === "merit") {
    next.title = prepared.title;next.body = prepared.description;
    for (const [key, value] of Object.entries(prepared.criteria)) next[key] = String(value);
    // Every recipient's values and the common block of «Одинаково для всех».
    for (const key of Object.keys(next)) { if (key.startsWith("hours_") || key === "common_hours") next[key] = String(prepared.hours);if (key.startsWith("evaluation_") || key === "common_evaluation") next[key] = String(prepared.evaluation); }
  } else { next.hours = String(prepared.hours);next.evaluation = String(prepared.evaluation); }
  void form.setValues(next);
}

/** Copies only template fields into this Formik draft. Never submits an assessment. */
export function KkrTemplateTools({ form, mode, selection, onSelection, target }: {
  form: FormikProps<Values>; mode: "merit" | "assessment"; selection: TemplateSelection | null;
  onSelection: (selection: TemplateSelection | null) => void;
  /** The record's team: only templates the server takes for it are offered. */
  target?: TemplateTarget;
}) {
  const query = useQuery({ queryKey: ["kkrTemplates"], queryFn: profileFeaturesApi.templates });
  const data = !query.error || canRetainData(query.error) ? query.data : undefined;
  const offered = useFittingTemplates(data?.items, target);
  const [selected, setSelected] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const initial = (): TemplateValues => {
    const recipient = Array.isArray(form.values.users) ? form.values.users[0] : null;
    // A merit's values: the common block when it applies to the first recipient, else that recipient's own.
    const common = mode === "merit" && form.values.same_for_all === "true" && Array.isArray(form.values.users) && form.values.users.length > 1 && form.values[`own_${recipient}`] !== "true";
    const key = (name: string) => common ? `common_${name}` : recipient && mode === "merit" ? `${name}_${recipient}` : name;
    const evaluation = text(form.values, key("evaluation"));
    return { title: text(form.values, "title") || "Шаблон оценки", description: text(form.values, "body"), hours: number(form.values, key("hours")), evaluation: (evaluation === "" ? 1 : Number(evaluation)) as TemplateValues["evaluation"], criteria: { ...emptyCriteria(), ...criteriaFromValues(form.values) } };
  };
  return <div className={s.templateTools}>
    <EntityPicker label="Шаблон ККР" name="kkr-template" value={selected} onChange={setSelected} placeholder="Найти шаблон" disabled={busy || form.isSubmitting}
      options={offered.map(row => ({ value: row.template_id, label: `${row.values.title} · ${templateOwner(row)}` }))} />
    <button type="button" className={w.button} disabled={!offered.some(row => row.template_id === selected) || busy || form.isSubmitting} onClick={() => {
      const template = offered.find(row => row.template_id === selected);if (!template) return;setBusy(true);setError(null);
      void profileFeaturesApi.prepare(template).then(prepared => { applyTemplate(form, mode, prepared.values);onSelection(prepared.selection); }).catch(setError).finally(() => setBusy(false));
    }}>Подставить шаблон</button>
    <button ref={anchor} type="button" className={w.button} onClick={() => setOpen(true)}>Сохранить как шаблон / Управление</button>
    {/* No «Отвязать шаблон»: a save the template blocks offers to go on without it (B6, owner 2026-11-08). */}
    {selection && <small>Шаблон подставлен. Проверьте поля и сохраните {mode === "merit" ? "работу" : "оценку"}.</small>}
    {error != null && <QueryState loading={false} error={error}>{null}</QueryState>}
    {query.error && <QueryState loading={false} error={query.error}>{null}</QueryState>}
    <UnsavedChangesScope><TemplatePopover open={open} anchor={anchor} close={() => setOpen(false)} initialValues={initial()} /></UnsavedChangesScope>
  </div>;
}

/**
 * Under a save refused because of its template: the same save without the template link and,
 * for a template edited after «Подставить», its current version (B6, owner 2026-11-08).
 * Renders nothing for other refusals.
 */
export function TemplateRefusal({ failure, form, mode, selection, onSelection }: {
  failure: unknown; form: FormikProps<Values>; mode: "merit" | "assessment";
  selection: TemplateSelection | null; onSelection: (selection: TemplateSelection | null) => void;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false), [note, setNote] = useState(""), [error, setError] = useState<unknown>(null);
  // The save repeats once the form has dropped the link, so it sends exactly the same values without it.
  const retry = useRef(false);
  useEffect(() => { if (retry.current && !selection) { retry.current = false;void form.submitForm(); } }, [selection, form]);
  if (!templateRefused(failure)) return null;
  const reapply = async () => {
    if (!selection) return;
    setBusy(true);setError(null);setNote("");
    try {
      const list = await client.fetchQuery({ queryKey: ["kkrTemplates"], queryFn: profileFeaturesApi.templates, staleTime: 0 });
      const current = list.items.find(row => row.template_id === selection.template_id);
      if (!current || current.archived) throw current ? new ApiError("Шаблон в архиве", 409, "template_archived") : new ApiError("Шаблон недоступен", 404, "template_unavailable");
      const prepared = await profileFeaturesApi.prepare(current);
      applyTemplate(form, mode, prepared.values);onSelection(prepared.selection);
      setNote("Шаблон подставлен заново. Проверьте поля и сохраните.");
    } catch (reason) { setError(reason); } finally { setBusy(false); }
  };
  return <div className={w.row}>
    <button type="button" className={w.button} disabled={busy || form.isSubmitting} onClick={() => { if (!selection) { void form.submitForm();return; } retry.current = true;onSelection(null); }}>Сохранить без шаблона</button>
    {normalizeApiError(failure).code === "template_changed" && selection && <button type="button" className={w.button} disabled={busy || form.isSubmitting} onClick={() => void reapply()}>{busy ? "Подставляем…" : "Подставить заново"}</button>}
    {note && <p role="status">{note}</p>}
    {error != null && <p role="alert">{userMessage(error)}</p>}
  </div>;
}
function TemplatePopover({ open, anchor, close, initialValues }: { open: boolean; anchor: React.RefObject<HTMLButtonElement | null>; close: () => void; initialValues: TemplateValues }) {
  const leave = useGuardedAction();
  // The window is portalled outside the page: `controls` gives its filters and its editor the site's lists and boxes.
  return <AnchoredPopover open={open} anchorRef={anchor} label="Шаблоны ККР" onRequestClose={() => leave(close)} width={480} className={l.controls}><KkrTemplateLibrary embedded initialValues={initialValues} /></AnchoredPopover>;
}
