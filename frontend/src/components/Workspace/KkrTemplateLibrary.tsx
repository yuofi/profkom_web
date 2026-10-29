import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { FormikProps } from "formik";
import { emptyCriteria } from "../../utils/api/contract";
import { profileFeaturesApi, type FeaturesContext, type KkrTemplate, type TemplateSelection, type TemplateValues } from "../../utils/api/profileFeatures.api";
import { canRetainData } from "../../utils/api/request";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm, type Field } from "./ActionForm";
import { AnchoredPopover } from "./AnchoredPopover";
import { UnsavedChangesScope } from "./UnsavedChanges";
import { useGuardedAction } from "./unsavedChangesHooks";
import { EntityPicker } from "./EntityPicker";
import { text, number, type Values } from "./formValues";
import { Card, Empty, QueryState } from "./WorkspaceUI";
import s from "./ProfileFeatures.module.css";
import w from "./Workspace.module.css";
const criteriaLabels = { unique: "Уникальная работа", creative: "Творческая", external_communication: "Общение вне вуза", in_person: "Очное присутствие", fixed_time: "В определённое время" };
const emptyValues = (): TemplateValues => ({ title: "", description: "", hours: 0, evaluation: 1, criteria: emptyCriteria() });
type EditorChoice = { template?: KkrTemplate; values: TemplateValues };
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
  const [editing, setEditing] = useState<EditorChoice | null>(null), [generation, setGeneration] = useState(0);
  const leave = useGuardedAction(), { perform, refresh } = useWorkspaceActions();
  const template = editing?.template;
  const choose = (next: EditorChoice) => leave(() => { setEditing(next);setGeneration(value => value + 1); });
  const values = editing?.values;
  const fields: Field[] = values ? [
    { name: "title", label: "Название работы / шаблона", value: values.title, required: true },
    { name: "body", label: "Описание работы", value: values.description, type: "textarea" },
    { name: "hours", label: "Часы", type: "number", min: 0, required: true, value: String(values.hours) },
    { name: "evaluation", label: "Оценка", type: "select", required: true, value: String(values.evaluation), options: [-1, 0, 1, 1.5].map(value => ({ value: String(value), label: String(value) })) },
    ...Object.entries(criteriaLabels).map(([name, label]) => ({ name, label, type: "select" as const, value: String(values.criteria[name as keyof typeof criteriaLabels]), options: [{ value: "false", label: "Нет" }, { value: "true", label: "Да" }] })),
    ...(template ? [{ name: "archived", label: "Состояние шаблона", type: "select" as const, value: String(template.archived), options: [{ value: "false", label: "Активен" }, { value: "true", label: "В архиве" }] }] : [{ name: "visibility", label: "Кому доступен шаблон", type: "select" as const, required: true, value: "personal", options: [
      ...(context.can_create_personal_template ? [{ value: "personal", label: "Только мне" }] : []),
      ...context.template_scopes.map((scope, index) => ({ value: String(index), label: `Команде: ${scope.name}` })),
    ] }]),
  ] : [];
  return <div className={s.library}>
    {context.can_create_personal_template && <button type="button" className={w.button} onClick={() => choose({ values: initialValues ?? emptyValues() })}>Создать шаблон ККР</button>}
    {!templates.length && <Empty>Пока нет доступных шаблонов.</Empty>}
    {templates.map(row => <div className={s.badge} key={row.template_id}><strong>{row.values.title}</strong><span>{row.visibility === "personal" ? "Личный" : row.scope?.name} · {row.archived ? "В архиве" : `${row.values.hours} ч · оценка ${row.values.evaluation}`}</span><div className={w.row}>
      <button type="button" className={w.button} onClick={() => choose({ template: row, values: row.values })}>Изменить шаблон</button>
      {context.can_create_personal_template && <button type="button" className={w.button} onClick={() => choose({ values: { ...row.values, title: `${row.values.title} · копия` } })}>Копировать</button>}
    </div></div>)}
    {editing && <><ActionForm key={generation} revision={template?.revision} onConflict={refresh} fields={fields} submitLabel="Сохранить шаблон"
      onSubmit={async (draft, revision) => {
        const data: TemplateValues = { title: text(draft, "title"), description: text(draft, "body"), hours: number(draft, "hours"), evaluation: number(draft, "evaluation") as TemplateValues["evaluation"], criteria: { ...emptyCriteria(), ...Object.fromEntries(Object.keys(criteriaLabels).map(key => [key, text(draft, key) === "true"])) } };
        const selected = text(draft, "visibility"), scope = context.template_scopes[Number(selected)];
        if (!template && selected !== "personal" && !scope) throw Error("Выберите область шаблона");
        const saved = await perform(() => template
          ? profileFeaturesApi.updateTemplate({ ...template, revision: revision! }, data, text(draft, "archived") === "true")
          : profileFeaturesApi.createTemplate({ visibility: selected === "personal" ? "personal" : "team", ...(selected !== "personal" ? { scope_kind: scope.kind, scope_id: scope.id } : {}), values: data }));
        setEditing({ template: saved, values: saved.values });return { revision: saved.revision };
      }} /><button type="button" className={w.button} onClick={() => leave(() => setEditing(null))}>Закрыть редактор шаблона</button></>}
  </div>;
}

/** Copies only template fields into this Formik draft. Never submits an assessment. */
export function KkrTemplateTools({ form, mode, selection, onSelection }: {
  form: FormikProps<Values>; mode: "merit" | "assessment"; selection: TemplateSelection | null;
  onSelection: (selection: TemplateSelection | null) => void;
}) {
  const query = useQuery({ queryKey: ["kkrTemplates"], queryFn: profileFeaturesApi.templates });
  const data = !query.error || canRetainData(query.error) ? query.data : undefined;
  const [selected, setSelected] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const initial = (): TemplateValues => {
    const recipient = Array.isArray(form.values.users) ? form.values.users[0] : null;
    const evaluation = text(form.values, recipient && mode === "merit" ? `evaluation_${recipient}` : "evaluation");
    return { title: text(form.values, "title") || "Шаблон оценки", description: text(form.values, "body"), hours: number(form.values, recipient && mode === "merit" ? `hours_${recipient}` : "hours"), evaluation: (evaluation === "" ? 1 : Number(evaluation)) as TemplateValues["evaluation"], criteria: { ...emptyCriteria(), ...Object.fromEntries(Object.keys(criteriaLabels).map(key => [key, text(form.values, key) === "true"])) } };
  };
  return <div className={s.templateTools}>
    <EntityPicker label="Шаблон ККР" name="kkr-template" value={selected} onChange={setSelected} placeholder="Найти шаблон" disabled={busy || form.isSubmitting}
      options={(data?.items ?? []).filter(row => !row.archived).map(row => ({ value: row.template_id, label: `${row.values.title} · ${row.visibility === "personal" ? "личный" : row.scope?.name}` }))} />
    <button type="button" className={w.button} disabled={!selected || busy || form.isSubmitting} onClick={() => {
      const template = data?.items.find(row => row.template_id === selected);if (!template) return;setBusy(true);setError(null);
      void profileFeaturesApi.prepare(template).then(prepared => {
        const next = { ...form.values };
        if (mode === "merit") {
          next.title = prepared.values.title;next.body = prepared.values.description;
          for (const [key, value] of Object.entries(prepared.values.criteria)) next[key] = String(value);
          for (const key of Object.keys(next)) { if (key.startsWith("hours_")) next[key] = String(prepared.values.hours);if (key.startsWith("evaluation_")) next[key] = String(prepared.values.evaluation); }
        } else { next.hours = String(prepared.values.hours);next.evaluation = String(prepared.values.evaluation); }
        void form.setValues(next);onSelection(prepared.selection);
      }).catch(setError).finally(() => setBusy(false));
    }}>Подставить шаблон</button>
    <button ref={anchor} type="button" className={w.button} onClick={() => setOpen(true)}>Сохранить как шаблон / Управление</button>
    {selection && <small>Шаблон подставлен. Проверьте поля и сохраните {mode === "merit" ? "работу" : "оценку"}. <button type="button" className={w.button} onClick={() => onSelection(null)}>Отвязать шаблон</button></small>}
    {error != null && <QueryState loading={false} error={error}>{null}</QueryState>}
    {query.error && <QueryState loading={false} error={query.error}>{null}</QueryState>}
    <UnsavedChangesScope><TemplatePopover open={open} anchor={anchor} close={() => setOpen(false)} initialValues={initial()} /></UnsavedChangesScope>
  </div>;
}
function TemplatePopover({ open, anchor, close, initialValues }: { open: boolean; anchor: React.RefObject<HTMLButtonElement | null>; close: () => void; initialValues: TemplateValues }) {
  const leave = useGuardedAction();
  return <AnchoredPopover open={open} anchorRef={anchor} label="Шаблоны ККР" onRequestClose={() => leave(close)} width={480}><KkrTemplateLibrary embedded initialValues={initialValues} /></AnchoredPopover>;
}
