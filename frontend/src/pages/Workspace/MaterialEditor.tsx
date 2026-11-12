import { lazy, Suspense, useState } from "react";
import { displayDate } from "../../utils/dates";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { SectionHomeLink } from "../../components/Workspace/SectionHomeLink";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { MarkdownContent } from "../../components/Workspace/MarkdownContent";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { MaterialContent } from "../../components/Workspace/MaterialContent";
import { EntityPicker } from "../../components/Workspace/EntityPicker";
import { MaterialAudience } from "../../components/Workspace/MaterialAudience";
import { Empty, QueryState } from "../../components/Workspace/WorkspaceUI";
import { ids } from "../../components/Workspace/formValues";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { canRetainData } from "../../utils/api/request";
import { isStale } from "../../utils/api/messages";
import { materialsApi } from "../../utils/api/materials.api";
import { membershipApi } from "../../utils/api/membership.api";
import type { Material, MaterialText } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { usePeopleOptions, useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { getMaterialRoute } from "../../utils/routes";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./MaterialWorkspace.module.css";

const kinds: Record<string, string> = { kmb: "КМБ", guide: "Гайд блока", general: "Общий документ" };
const GuideInsertEditor = lazy(() => import("../../components/Workspace/GuideInsertEditor").then(module => ({ default: module.GuideInsertEditor })));
/** A title wraps to as many lines as it needs (GL-44). */
const grow = (element: HTMLTextAreaElement | null) => { if (element) { element.style.height = "auto";element.style.height = `${element.scrollHeight}px`; } };

/** Publication is always a separate explicit command; this editor only saves source drafts. */
export function MaterialEditor({ material: m, onClose }: { material?: Material; onClose?: () => void }) {
  const navigate = useNavigate(), leave = useGuardedAction(), { session } = useSession(), { perform, refresh } = useWorkspaceActions();
  const blocks = useQuery({ queryKey: ["workspaceBlocks"], queryFn: membershipApi.blocks, enabled: !m });
  const guideBlocks = (!blocks.error || canRetainData(blocks.error) ? blocks.data ?? [] : []).filter(block => can(block, "edit_block"));
  const shared = can(session, "create_shared_material");
  const availableKinds = [...(shared ? ["kmb", "general"] : []), ...(guideBlocks.length ? ["guide"] : [])];
  const [title, setTitle] = useState(m?.title ?? ""), [description, setDescription] = useState(m?.description ?? ""), [original, setOriginal] = useState(m?.original_link ?? "");
  // published_content contains short-lived signed file links. It is never an editing source.
  const [body, setBody] = useState(m?.source_content?.body ?? ""), [kind, setKind] = useState(m?.kind ?? ""), [block, setBlock] = useState("");
  const [format, setFormat] = useState<MaterialText["format"]>(m?.source_content?.format ?? "markdown");
  const [saving, setSaving] = useState(false), [uploading, setUploading] = useState(false);
  // Every refused field at once, each cleared by its own edit (GL-17).
  const [problems, setProblems] = useState<Partial<Record<"title" | "description" | "original" | "kind" | "block", string>>>({});
  const edited = (name: keyof typeof problems) => setProblems(current => { if (!current[name]) return current;const next = { ...current };delete next[name];return next; });
  const problem = (name: keyof typeof problems) => problems[name] && <span id={`material-${name}-error`} className={w.fieldError}>{problems[name]}</span>;
  const invalid = (name: keyof typeof problems) => problems[name] ? { "aria-invalid": true, "aria-describedby": `material-${name}-error` } : {};
  const external = { title, description, original, body, format, kind, block };
  const [initial] = useState(external);
  const saved = m ? { title: m.title, description: m.description, original: m.original_link ?? "", body: m.source_content?.body ?? "", format: m.source_content?.format ?? "markdown", kind: m.kind, block: "" } : initial;
  const replace = () => { setTitle(saved.title);setDescription(saved.description);setOriginal(saved.original);setBody(saved.body);setFormat(saved.format);setKind(saved.kind);setBlock(saved.block); };
  const editable = !m || can(m, "edit_material");
  const close = () => { if (onClose) leave(onClose);else navigate("/materials"); };
  const stateDetails = <><dl><dt>Название</dt><dd>{saved.title}</dd><dt>Описание</dt><dd>{saved.description || "—"}</dd><dt>Ссылка на оригинал</dt><dd>{saved.original || "—"}</dd></dl><MarkdownContent body={saved.body} /></>;
  return <>
    <BrandedHeader className={s.header}><div><SectionHomeLink to="/materials" label="Материалы" /><nav aria-label="Путь редактора материала"><Link to="/materials">Материалы</Link><span>›</span><span>{m ? "Редактирование материала" : "Новый материал"}</span></nav><div className={s.titleRow}><h1 className={w.title}>{m ? "Редактировать материал" : "Новый материал"}</h1><button type="button" className={w.button} disabled={saving} onClick={close}>{m ? "Готово" : "Отмена"}</button></div><p className={w.description}>{m ? "Сохраните изменения в черновик. Публикация обновит материал для читателей." : "Заполните материал и сохраните черновик. Опубликовать его можно отдельным действием."}</p></div></BrandedHeader>
    <div className={s.workspace}>
      <section className={s.main} aria-label="Текст материала">
        {editable ? <ActionForm fields={[]} revision={m?.revision} record={m ? `material:${m.material_id}` : undefined} externalState={external} savedExternalState={saved} externalBusy={saving || uploading} savedDetails={stateDetails} onReplaceWithSaved={replace} onConflict={refresh} submitLabel={m ? "Сохранить черновик" : "Создать черновик"} allowExitSave={!!m} onSubmit={async (_values, revision) => {
          const found = {
            ...(!title.trim() && { title: "Введите название материала." }),
            ...(!m && !description.trim() && { description: "Добавьте краткое описание материала." }),
            ...(original && !/^https?:\/\//i.test(original) && { original: "Используйте ссылку https:// или http://." }),
            ...(!m && !availableKinds.includes(kind) && { kind: "Выберите доступный раздел материала." }),
            ...(!m && kind === "guide" && !guideBlocks.some(item => item.block_id === block) && { block: "Выберите блок для гайда." }),
          };
          setProblems(found);
          if (Object.keys(found).length) throw Error(`Проверьте поля: ${Object.values(found).join(" ")}`);
          setSaving(true);
          try {
            const result = await perform(() => m ? materialsApi.update(m.material_id, { expected_revision: revision!, title: title.trim(), description, original_link: original || null, content: { format, body } }) : materialsApi.create({ title: title.trim(), description, kind, ...(kind === "guide" ? { owner_block_id: block } : {}), ...(original ? { original_link: original } : {}), content: { format, body } }));
            // A new draft opens in its editor, with publication at hand (GL-17); it replaces the
            // blank /materials/new entry, so Back leads to where creation started.
            if (!m) navigate(`${getMaterialRoute(result.material_id)}?edit=1`, { replace: true });
            return result;
          } finally { setSaving(false); }
        }}>
          <label className={`${w.field} ${s.title}`}>Название материала<textarea name="title" rows={1} value={title} ref={grow} onChange={event => { setTitle(event.target.value.replace(/\s*\n\s*/g, " "));edited("title");grow(event.currentTarget); }} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} placeholder="Название материала" required disabled={saving} autoFocus {...invalid("title")} />{problem("title")}</label>
          {m?.kind === "guide" && (can(m, "edit_html_material") || format === "markdown-embeds-v1") ? <Suspense fallback={<p role="status">Загружаем редактор гайда…</p>}><GuideInsertEditor material={m} value={body} format={format} onChange={setBody} onFormatChange={setFormat} disabled={saving || uploading} onBusyChange={setUploading} /></Suspense> : <MarkdownEditor name="body" label="Текст материала" value={body} onChange={setBody} rows={20} disabled={saving} context="material" />}
          {!m && kind === "guide" && <p className={w.muted}>Сначала сохраните черновик. Затем можно добавить оформленные плашки, кнопки, таблицы и загрузить изображения.</p>}
          {/* Before the save button on every width, not after the form in the side column (GL-43). */}
          <label className={w.field}>Краткое описание<textarea name="description" rows={3} value={description} onChange={event => { setDescription(event.target.value);edited("description"); }} disabled={saving} required={!m} {...invalid("description")} />{problem("description")}</label>
          <label className={w.field}>Ссылка на оригинал<input name="original" type="url" value={original} onChange={event => { setOriginal(event.target.value);edited("original"); }} placeholder="https://" disabled={saving} {...invalid("original")} />{problem("original")}</label>
        </ActionForm> : <section className={s.reading}>{m?.published_content ? <MaterialContent content={m.published_content} materialId={m.material_id} /> : <Empty>Материал ещё не опубликован.</Empty>}</section>}
      </section>
      <aside className={s.parameters} aria-label="Параметры материала"><h2>Параметры</h2>
        {!editable && <p className={w.muted}>{m?.description}</p>}
        {m ? <div className={s.metadata}><span>Раздел</span><strong>{kinds[m.kind] ?? m.kind}</strong></div> : <QueryState loading={blocks.isLoading} error={blocks.error} keepDataOnError={!!blocks.data} retry={() => { void blocks.refetch(); }}>
          <label className={w.field}>Раздел<select name="kind" value={kind} onChange={event => { setKind(event.target.value);setBlock("");edited("kind");edited("block"); }} disabled={saving} required {...invalid("kind")}><option value="">Выберите раздел…</option>{availableKinds.map(value => <option key={value} value={value}>{kinds[value]}</option>)}</select>{problem("kind")}</label>
          {kind === "guide" && <div className={w.field}><label htmlFor="material-owner-block">Блок — для гайда</label><EntityPicker id="material-owner-block" name="block" label="Блок — для гайда" entity="block" value={block} onChange={value => { setBlock(value);edited("block"); }} options={guideBlocks.map(item => ({ value: item.block_id, label: item.name, block: item }))} disabled={saving} required />{problem("block")}</div>}
        </QueryState>}
        {m && <MaterialManagement material={m} onDeleteBusy={setSaving} busy={saving || uploading} />}
      </aside>
    </div>
  </>;
}

function MaterialManagement({ material: m, onDeleteBusy, busy }: { material: Material; onDeleteBusy: (busy: boolean) => void; busy: boolean }) {
  const { session } = useSession(), { perform, refresh } = useWorkspaceActions();
  const draftDiagnostics = m.draft_content?.render?.diagnostics ?? [];
  const draftInvalid = m.draft_content?.format === "markdown-embeds-v1" && (!m.draft_content.render || draftDiagnostics.length > 0);
  return <>
    {can(m, "publish_material") && <section className={s.management}><h3>Публикация</h3><p className={w.muted}>{m.published_content ? m.published_at ? `Опубликовано ${displayDate(m.published_at)}.` : "Опубликовано." : "Ещё не опубликовано."}</p><p className={w.muted}>{m.draft_content ? "Есть сохранённый черновик. Публикация применит именно его, без несохранённых правок." : "Сначала сохраните черновик материала."}</p>{draftInvalid && <div role="alert"><p>Исправьте оформление и сохраните черновик перед публикацией.</p><ul>{draftDiagnostics.map((problem, index) => <li key={index}>Строка {problem.line}: {problem.message}</li>)}</ul></div>}{m.draft_content?.format === "markdown-embeds-v1" && <PublicationComparison material={m} />}<ActionForm revision={m.revision} record={`material:${m.material_id}`} fields={[]} disabled={!m.draft_content || draftInvalid || busy} savedDetails={m.draft_content ? <MaterialContent content={m.draft_content} materialId={`${m.material_id}-saved`} showToc={false} /> : undefined} allowExitSave={false} submitLabel="Опубликовать сохранённый черновик" onConflict={refresh} onSubmit={async (_values, revision) => perform(() => materialsApi.publish(m.material_id, { expected_revision: revision! }))} /></section>}
    {m.audience && <section className={s.management}><h3>Кто видит гайд</h3><MaterialAudience material={m} /></section>}
    {m.owner_block_id === null && can(session, "manage_material_editors") && <MaterialEditors material={m} />}
    {can(m, "delete_material") && <MaterialDeletion material={m} onBusy={onDeleteBusy} />}
  </>;
}
function MaterialEditors({ material: m }: { material: Material }) {
  const people = usePeopleOptions(), { perform, refresh } = useWorkspaceActions();
  return <section className={s.management}><h3>Редакторы общего материала</h3><p className={w.muted}>Выберите полный состав редакторов этого материала.</p><ActionForm revision={m.revision} record={`material:${m.material_id}`} fields={[{ name: "users", label: "Редакторы", type: "multi", value: m.editor_user_ids?.map(String) ?? [], options: people.options, loading: people.isLoading }]} submitLabel="Установить состав редакторов" onConflict={refresh} onSubmit={async (values, revision) => perform(() => materialsApi.editors(m.material_id, ids(values, "users"), { expected_revision: revision! }))} /></section>;
}

/** Closed comparisons never mount extra readers or start image requests. */
function PublicationComparison({ material: m }: { material: Material }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>Сравнить с публикацией</summary>{open && <><h4>Сейчас видят читатели</h4>{m.published_content ? <MaterialContent content={m.published_content} materialId={`${m.material_id}-published-comparison`} showToc={false} /> : <p>Ещё не опубликовано.</p>}<h4>Сохранённый черновик</h4>{m.draft_content && <MaterialContent content={m.draft_content} materialId={`${m.material_id}-draft-comparison`} showToc={false} />}</>}</details>;
}

function MaterialDeletion({ material: m, onBusy }: { material: Material; onBusy: (busy: boolean) => void }) {
  // The deleted material's cache goes too: Back must not show it as readable (GL-28).
  const navigate = useNavigate(), leave = useGuardedAction(), { refresh } = useWorkspaceActions(), client = useQueryClient();
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<unknown>(null);
  return <details className={`${w.details} ${s.management}`}><summary>Удалить материал</summary><p>Материал вместе с черновиком скроется у всех читателей. Председатель и замы могут его восстановить.</p>
    <form className={w.form} onSubmit={event => { event.preventDefault();if (busy) return;leave(async () => {
      setBusy(true);onBusy(true);setFailure(null);
      try { await materialsApi.remove(m.material_id, { expected_revision: m.revision });navigate("/materials", { replace: true });client.removeQueries({ queryKey: ["materials", m.material_id] });await refresh(); }
      catch (error) { setFailure(error);if (isStale(error)) await refresh(); }
      finally { setBusy(false);onBusy(false); }
    }); }}><button className={`${w.button} ${w.danger}`} type="submit" disabled={busy}>{busy ? "Удаляем…" : "Удалить материал"}</button></form>
    {failure != null && <QueryState loading={false} error={failure}>{null}</QueryState>}
  </details>;
}
