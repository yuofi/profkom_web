import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Page,
  Card,
  QueryState,
  RouteLink,
  Badge,
  Empty,
  Glyph,
} from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { materialsApi } from "../../utils/api/materials.api";
import { can, useSession } from "../../utils/session";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { SectionHomeLink } from "../../components/Workspace/SectionHomeLink";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { canRetainData, normalizeApiError } from "../../utils/api/request";
import type { Material } from "../../utils/api/contract";
import { displayDate } from "../../utils/dates";
import { getMaterialCreateRoute } from "../../utils/routes";
import { MaterialAudience } from "../../components/Workspace/MaterialAudience";
import u from "./MaterialWorkspace.module.css";
import s from "../../components/Workspace/Workspace.module.css";
import cards from "./MaterialCards.module.css";
// The catalogue needs neither the Markdown renderer nor the editor: each loads where it is shown.
const MaterialContent = lazy(() => import("../../components/Workspace/MaterialContent").then(module => ({ default: module.MaterialContent })));
const MaterialEditor = lazy(() => import("./MaterialEditor").then(module => ({ default: module.MaterialEditor })));
const loading = <p className={s.muted} role="status">Загружаем…</p>;
export function MaterialsPage() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const kind = ["kmb", "guide", "general"].includes(params.get("kind") ?? "") ? params.get("kind")! : "";
  // Filters live in the URL, so Back and a shared link keep them (GL-29).
  const setParam = (key: string, value: string) => setParams(previous => { const next = new URLSearchParams(previous);if (value) next.set(key, value);else next.delete(key);return next; }, { replace: true });
  const search = params.get("q") ?? "", setSearch = (value: string) => setParam("q", value), setKind = (value: string) => setParam("kind", value);
  const query = useQuery({
    queryKey: ["materials"],
    queryFn: materialsApi.list,
  });
  const visibleItems = (query.data?.items ?? []).filter((m) =>
    (!kind || m.kind === kind) && `${m.title} ${m.description}`.toLocaleLowerCase("ru").includes(search.trim().toLocaleLowerCase("ru")),
  );
  const clearFilters = () => setParams(previous => { const next = new URLSearchParams(previous);next.delete("q");next.delete("kind");return next; }, { replace: true });
  // КМБ and documents first, then published guides; guides still in preparation fold away.
  const order = ["kmb", "general", "guide"], byTitle = (a: Material, b: Material) => a.title.localeCompare(b.title, "ru");
  const ready = visibleItems.filter(m => !m.placeholder).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || byTitle(a, b));
  const preparing = visibleItems.filter(m => m.placeholder).sort(byTitle);
  return (
    <Page
      title="Материалы"
      description="КМБ, гайды и полезные документы для работы."
      actions={can(session, "create_material") && <RouteLink to={getMaterialCreateRoute()}><Glyph name="add" />Создать материал</RouteLink>}
    >
      <div className={s.stack}>
        <div className={s.filters}>
          <label className={s.field}>
            Поиск
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <label className={s.field}>
            Раздел
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Все материалы</option>
              <option value="kmb">КМБ</option>
              <option value="guide">Гайды блоков</option>
              <option value="general">Общие документы</option>
            </select>
          </label>
        </div>
        <QueryState
          keepDataOnError={!!query.data}
          loading={query.isLoading}
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        >
          {ready.length > 0 && <MaterialCards items={ready} />}
          {preparing.length > 0 && <details className={s.details} open={!ready.length || kind === "guide" || !!search.trim()}>
            <summary>Гайды блоков в подготовке · {preparing.length}</summary>
            <MaterialCards items={preparing} />
          </details>}
          {!!query.data?.items.length && !visibleItems.length && (
            <Empty>Ничего не найдено. Измените условия поиска или <button className={s.button} onClick={clearFilters}>Сбросить фильтры</button>.</Empty>
          )}
          {query.data?.items.length === 0 && (
            <Empty>
              Материалы готовятся. Начните с КМБ или уточните у мастера блока,
              какие документы нужны для первой задачи.
            </Empty>
          )}
        </QueryState>
        {can(session, "restore_material") && <DeletedMaterials />}
      </div>
    </Page>
  );
}
function MaterialCards({ items }: { items: Material[] }) {
  return <div className={cards.grid}>
    {items.map((m) => (
      <Card key={m.material_id} title={m.title} className={cards.card}>
        <div className={s.badges}>
          <Badge tone={m.kind === "kmb" ? "yellow" : m.kind === "guide" ? "lilac" : "sky"}>
            {m.kind === "kmb" ? "КМБ" : m.kind === "guide" ? "Гайд" : "Документ"}
          </Badge>
          {m.audience === "block" && <Badge tone="peach">Для участников блока</Badge>}
        </div>
        <p className={cards.description}>{m.description}</p>
        <RouteLink to={`/materials/${encodeURIComponent(m.material_id)}`}>Открыть</RouteLink>
      </Card>
    ))}
  </div>;
}
function DeletedMaterials() {
  const { perform, refresh } = useWorkspaceActions();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["materials", "deleted"],
    queryFn: materialsApi.deleted,
    enabled: open,
  });
  return (
    <details className={s.details} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Удалённые материалы</summary>
      <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
        {query.data?.items.length === 0 && <Empty>Удалённых материалов нет.</Empty>}
        {query.data?.items.map((m) => (
          <Card key={m.material_id} title={m.title}>
            <p className={s.muted}>{m.deleted_at ? `Удалён ${new Date(m.deleted_at).toLocaleDateString("ru-RU")}. Хранится в корзине один год.` : "Дата удаления неизвестна; автоматическое удаление не назначено."}</p>
            <ActionForm
              revision={m.revision}
              fields={[]}
              submitLabel="Восстановить"
              onSubmit={async (_v, expectedRevision) =>
                perform(() => materialsApi.restore(m.material_id, { expected_revision: expectedRevision! }))
              }
              onConflict={refresh}
            />
          </Card>
        ))}
      </QueryState>
    </details>
  );
}
export function MaterialCreatePage() {
  const { session } = useSession();
  return can(session, "create_material")
    ? <section className={`${s.page} ${u.page}`}><UnsavedChangesScope><Suspense fallback={loading}><MaterialEditor /></Suspense></UnsavedChangesScope></section>
    : <Page title="Новый материал"><Empty>Создание материалов недоступно.</Empty><RouteLink to="/materials">Все материалы</RouteLink></Page>;
}
export function MaterialPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  // The editor is a URL state (?edit=1): it survives a reload and Back, and opens only for
  // a manager of this material (GL-17).
  const [params, setParams] = useSearchParams(), editing = params.get("edit") === "1";
  const setEditing = (value: boolean) => setParams(previous => { const next = new URLSearchParams(previous);if (value) next.set("edit", "1");else next.delete("edit");return next; }, { replace: !value });
  const query = useQuery({ queryKey: ["materials", id], queryFn: () => materialsApi.get(id) });
  // A denied refetch must hide both the cached title and the private draft.
  const m = !query.error || canRetainData(query.error) ? query.data : undefined;
  const manageable = !!m && (can(m, "edit_material") || can(m, "publish_material") || can(m, "edit_audience") || can(m, "delete_material") || m.owner_block_id === null && can(session, "manage_material_editors"));
  const missing = !!query.error && !m && [403, 404].includes(normalizeApiError(query.error).status);
  // A refusal or a lost right ends the edit mode; a later recovery opens read-only.
  const drop = editing && (!!query.error && !canRetainData(query.error) || !!m && !manageable);
  useEffect(() => { if (drop) setEditing(false); });
  // A temporary refetch failure is shown above the editor, which keeps the draft.
  if (m && editing && manageable) return <section className={`${s.page} ${u.page}`}><QueryState loading={false} error={query.error} keepDataOnError retry={() => { void query.refetch(); }}><UnsavedChangesScope><Suspense fallback={loading}><MaterialEditor key={m.material_id} material={m} onClose={() => setEditing(false)} /></Suspense></UnsavedChangesScope></QueryState></section>;
  return <section className={`${s.page} ${u.page}`}>
    {/* The header and the way back stay when the material cannot be read (GL-28). */}
    <BrandedHeader className={u.header}><div><SectionHomeLink to="/materials" label="Материалы" /><div className={u.titleRow}><h1 className={s.title}>{m?.title ?? (missing ? "Материал недоступен" : "Материал")}</h1>{manageable && <button type="button" className={u.pencil} aria-label="Редактировать материал" title="Редактировать материал" onClick={() => setEditing(true)}><Glyph name="edit" /></button>}</div>{m?.description && <p className={s.description}>{m.description}</p>}{manageable && m && <p className={s.description}>{m.published_content ? m.published_at ? `Опубликовано ${displayDate(m.published_at)}` : "Опубликовано" : "Не опубликовано"}{m.draft_content ? " · есть неопубликованный черновик" : ""}</p>}</div></BrandedHeader>
    {missing ? <div role="alert"><Empty>Материал не найден или доступ к нему закрыт.</Empty></div> : <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!m} retry={() => { void query.refetch(); }}>
      {m && <>
        <Card className={u.reading}>
          {m.placeholder && m.community_url && <a className={s.linkButton} href={m.community_url} target="_blank" rel="noopener noreferrer">Сообщество блока</a>}
          {m.published_content ? <Suspense fallback={loading}><MaterialContent body={m.published_content.body} /></Suspense> : <Empty>Материал ещё готовится. Опубликованный текст появится здесь.</Empty>}
          {m.original_link && <a className={s.linkButton} href={m.original_link} target="_blank" rel="noopener noreferrer">Открыть оригинал</a>}
        </Card>
        {m.audience && <div className={u.audience}><MaterialAudience material={m} /></div>}
      </>}
    </QueryState>}
    {!query.isLoading && <Link className={s.linkButton} to="/materials">Все материалы</Link>}
  </section>;
}
