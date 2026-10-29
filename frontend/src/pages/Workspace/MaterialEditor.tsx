import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { SectionHomeLink } from "../../components/Workspace/SectionHomeLink";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { MarkdownContent } from "../../components/Workspace/MarkdownContent";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { EntityPicker } from "../../components/Workspace/EntityPicker";
import { MaterialAudience } from "../../components/Workspace/MaterialAudience";
import { Empty, QueryState } from "../../components/Workspace/WorkspaceUI";
import { ids } from "../../components/Workspace/formValues";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { canRetainData } from "../../utils/api/request";
import { materialsApi } from "../../utils/api/materials.api";
import { membershipApi } from "../../utils/api/membership.api";
import { richText, type Material } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { usePeopleOptions, useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { getMaterialRoute } from "../../utils/routes";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./MaterialWorkspace.module.css";

const kinds: Record<string, string> = { kmb: "КМБ", guide: "Гайд блока", general: "Общий документ" };

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
  const [saving, setSaving] = useState(false);
  const external = { title, description, original, body, kind, block };
  const [initial] = useState(external);
  const saved = m ? { title: m.title, description: m.description, original: m.original_link ?? "", body: m.source_content?.body ?? "", kind: m.kind, block: "" } : initial;
  const replace = () => { setTitle(saved.title);setDescription(saved.description);setOriginal(saved.original);setBody(saved.body);setKind(saved.kind);setBlock(saved.block); };
  const editable = !m || can(m, "edit_material");
  const close = () => { if (onClose) leave(onClose);else navigate("/materials"); };
  const stateDetails = <><dl><dt>Название</dt><dd>{saved.title}</dd><dt>Описание</dt><dd>{saved.description || "—"}</dd><dt>Ссылка на оригинал</dt><dd>{saved.original || "—"}</dd></dl><MarkdownContent body={saved.body} /></>;
  return <>
    <BrandedHeader className={s.header}><div><SectionHomeLink to="/materials" label="Материалы" /><nav aria-label="Путь редактора материала"><Link to="/materials">Материалы</Link><span>›</span><span>{m ? "Редактирование материала" : "Новый материал"}</span></nav><div className={s.titleRow}><h1 className={w.title}>{m ? "Редактировать материал" : "Новый материал"}</h1><button type="button" className={w.button} disabled={saving} onClick={close}>{m ? "Готово" : "Отмена"}</button></div><p className={w.description}>{m ? "Сохраните изменения в черновик. Публикация обновит материал для читателей." : "Заполните материал и сохраните черновик. Опубликовать его можно отдельным действием."}</p></div></BrandedHeader>
    <div className={s.workspace}>
      <section className={s.main} aria-label="Текст материала">
        {editable ? <ActionForm fields={[]} revision={m?.revision} record={m ? `material:${m.material_id}` : undefined} externalState={external} savedExternalState={saved} externalBusy={saving} savedDetails={stateDetails} onReplaceWithSaved={replace} onConflict={refresh} submitLabel={m ? "Сохранить черновик" : "Создать черновик"} allowExitSave={!!m} onSubmit={async (_values, revision) => {
          if (!title.trim()) throw Error("Введите название материала");
          if (!m && !description.trim()) throw Error("Добавьте краткое описание материала");
          if (original && !/^https?:\/\//i.test(original)) throw Error("Используйте ссылку https:// или http://");
          if (!m && !availableKinds.includes(kind)) throw Error("Выберите доступный раздел материала");
          if (!m && kind === "guide" && !guideBlocks.some(item => item.block_id === block)) throw Error("Выберите блок для гайда");
          setSaving(true);
          try {
            const result = await perform(() => m ? materialsApi.update(m.material_id, { expected_revision: revision!, title: title.trim(), description, original_link: original || null, content: richText(body) }) : materialsApi.create({ title: title.trim(), description, kind, ...(kind === "guide" ? { owner_block_id: block } : {}), ...(original ? { original_link: original } : {}), content: richText(body) }));
            if (!m) navigate(getMaterialRoute(result.material_id));
            return result;
          } finally { setSaving(false); }
        }}>
          <label className={`${w.field} ${s.title}`}>Название материала<input name="title" value={title} onChange={event => setTitle(event.target.value)} placeholder="Название материала" required disabled={saving} autoFocus /></label>
          <MarkdownEditor name="body" label="Текст материала" value={body} onChange={setBody} rows={20} disabled={saving} context="material" />
        </ActionForm> : <section className={s.reading}>{m?.published_content ? <MarkdownContent body={m.published_content.body} /> : <Empty>Материал ещё не опубликован.</Empty>}</section>}
      </section>
      <aside className={s.parameters} aria-label="Параметры материала"><h2>Параметры</h2>
        {editable ? <>
          <label className={w.field}>Краткое описание<textarea name="description" rows={3} value={description} onChange={event => setDescription(event.target.value)} disabled={saving} required={!m} /></label>
          <label className={w.field}>Ссылка на оригинал<input name="original" type="url" value={original} onChange={event => setOriginal(event.target.value)} placeholder="https://" disabled={saving} /></label>
        </> : <p className={w.muted}>{m?.description}</p>}
        {m ? <div className={s.metadata}><span>Раздел</span><strong>{kinds[m.kind] ?? m.kind}</strong></div> : <QueryState loading={blocks.isLoading} error={blocks.error} keepDataOnError={!!blocks.data} retry={() => { void blocks.refetch(); }}>
          <label className={w.field}>Раздел<select name="kind" value={kind} onChange={event => { setKind(event.target.value);setBlock(""); }} disabled={saving} required><option value="">Выберите раздел…</option>{availableKinds.map(value => <option key={value} value={value}>{kinds[value]}</option>)}</select></label>
          {kind === "guide" && <div className={w.field}><label htmlFor="material-owner-block">Блок — для гайда</label><EntityPicker id="material-owner-block" name="block" label="Блок — для гайда" entity="block" value={block} onChange={setBlock} options={guideBlocks.map(item => ({ value: item.block_id, label: item.name, block: item }))} disabled={saving} required /></div>}
        </QueryState>}
        {m && <MaterialManagement material={m} onDeleteBusy={setSaving} />}
      </aside>
    </div>
  </>;
}

function MaterialManagement({ material: m, onDeleteBusy }: { material: Material; onDeleteBusy: (busy: boolean) => void }) {
  const { session } = useSession(), { perform, refresh } = useWorkspaceActions();
  return <>
    {can(m, "publish_material") && <section className={s.management}><h3>Публикация</h3><p className={w.muted}>{m.draft_content ? "Есть сохранённый черновик. Публикация применит именно его, без несохранённых правок." : "Сначала сохраните черновик материала."}</p><ActionForm revision={m.revision} record={`material:${m.material_id}`} fields={[]} disabled={!m.draft_content} savedDetails={<MarkdownContent body={m.source_content?.body ?? ""} />} allowExitSave={false} submitLabel="Опубликовать сохранённый черновик" onConflict={refresh} onSubmit={async (_values, revision) => perform(() => materialsApi.publish(m.material_id, { expected_revision: revision! }))} /></section>}
    {m.audience && <section className={s.management}><h3>Кто видит гайд</h3><MaterialAudience material={m} /></section>}
    {m.owner_block_id === null && can(session, "manage_material_editors") && <MaterialEditors material={m} />}
    {can(m, "delete_material") && <MaterialDeletion material={m} onBusy={onDeleteBusy} />}
  </>;
}
function MaterialEditors({ material: m }: { material: Material }) {
  const people = usePeopleOptions(), { perform, refresh } = useWorkspaceActions();
  return <section className={s.management}><h3>Редакторы общего материала</h3><p className={w.muted}>Выберите полный состав редакторов этого материала.</p><ActionForm revision={m.revision} record={`material:${m.material_id}`} fields={[{ name: "users", label: "Редакторы", type: "multi", value: m.editor_user_ids?.map(String) ?? [], options: people.options, loading: people.isLoading }]} submitLabel="Установить состав редакторов" onConflict={refresh} onSubmit={async (values, revision) => perform(() => materialsApi.editors(m.material_id, ids(values, "users"), { expected_revision: revision! }))} /></section>;
}

function MaterialDeletion({ material: m, onBusy }: { material: Material; onBusy: (busy: boolean) => void }) {
  const navigate = useNavigate(), leave = useGuardedAction(), { refresh } = useWorkspaceActions();
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<unknown>(null);
  return <details className={`${w.details} ${s.management}`}><summary>Удалить материал</summary><p>Материал вместе с черновиком скроется у всех читателей. Председатель и замы могут его восстановить.</p>
    <form className={w.form} onSubmit={event => { event.preventDefault();if (busy) return;leave(async () => {
      setBusy(true);onBusy(true);setFailure(null);
      try { await materialsApi.remove(m.material_id);navigate("/materials", { replace: true });await refresh(); }
      catch (error) { setFailure(error); }
      finally { setBusy(false);onBusy(false); }
    }); }}><button className={`${w.button} ${w.danger}`} type="submit" disabled={busy}>{busy ? "Удаляем…" : "Удалить материал"}</button></form>
    {failure != null && <QueryState loading={false} error={failure}>{null}</QueryState>}
  </details>;
}
