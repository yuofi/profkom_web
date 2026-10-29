import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { MaterialContent } from "../../components/Workspace/MaterialContent";
import { materialsApi } from "../../utils/api/materials.api";
import { can, useSession } from "../../utils/session";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { SectionHomeLink } from "../../components/Workspace/SectionHomeLink";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { canRetainData } from "../../utils/api/request";
import { getMaterialCreateRoute } from "../../utils/routes";
import { MaterialEditor } from "./MaterialEditor";
import { MaterialAudience } from "../../components/Workspace/MaterialAudience";
import u from "./MaterialWorkspace.module.css";
import s from "../../components/Workspace/Workspace.module.css";
import cards from "./MaterialCards.module.css";
export function MaterialsPage() {
  const { session } = useSession();
  const [search, setSearch] = useState("");
  const [params, setParams] = useSearchParams();
  const kind = ["kmb", "guide", "general"].includes(params.get("kind") ?? "") ? params.get("kind")! : "";
  const setKind = (value: string) => setParams(previous => { const next = new URLSearchParams(previous);if (value) next.set("kind", value);else next.delete("kind");return next; });
  const query = useQuery({
    queryKey: ["materials"],
    queryFn: materialsApi.list,
  });
  const visibleItems = (query.data?.items ?? []).filter((m) =>
    (!kind || m.kind === kind) && `${m.title} ${m.description}`.toLocaleLowerCase("ru").includes(search.trim().toLocaleLowerCase("ru")),
  );
  const clearFilters = () => { setSearch(""); setKind(""); };
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
          <div className={cards.grid}>
            {visibleItems.map((m) => (
                <Card key={m.material_id} title={m.title} className={cards.card}>
                  <div className={s.badges}>
                    <Badge tone={m.kind === "kmb" ? "yellow" : m.kind === "guide" ? "lilac" : "sky"}>
                      {m.kind === "kmb"
                        ? "КМБ"
                        : m.kind === "guide"
                          ? "Гайд"
                          : "Документ"}
                    </Badge>
                    {m.audience === "block" && <Badge tone="peach">Для участников блока</Badge>}
                  </div>
                  <p className={cards.description}>{m.description}</p>
                  <RouteLink
                    to={`/materials/${encodeURIComponent(m.material_id)}`}
                  >
                    Открыть
                  </RouteLink>
                </Card>
              ))}
          </div>
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
function DeletedMaterials() {
  const { perform, refresh } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["materials", "deleted"],
    queryFn: materialsApi.deleted,
  });
  return (
    <details className={s.details}>
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
    ? <section className={`${s.page} ${u.page}`}><UnsavedChangesScope><MaterialEditor /></UnsavedChangesScope></section>
    : <Page title="Новый материал"><Empty>Создание материалов недоступно.</Empty><RouteLink to="/materials">Все материалы</RouteLink></Page>;
}
export function MaterialPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const [editing, setEditing] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["materials", id], queryFn: () => materialsApi.get(id) });
  // A denied refetch must hide both the cached title and the private draft.
  const m = !query.error || canRetainData(query.error) ? query.data : undefined;
  const manageable = !!m && (can(m, "edit_material") || can(m, "publish_material") || can(m, "edit_audience") || can(m, "delete_material") || m.owner_block_id === null && can(session, "manage_material_editors"));
  if (editing && (!manageable || editing !== id)) setEditing(null);
  return <section className={`${s.page} ${u.page}`}>
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!m} retry={() => { void query.refetch(); }}>
      {m && (editing === id && manageable ? <UnsavedChangesScope><MaterialEditor key={m.material_id} material={m} onClose={() => setEditing(null)} /></UnsavedChangesScope> : <>
        <BrandedHeader className={u.header}><div><SectionHomeLink to="/materials" label="Материалы" /><nav aria-label="Путь материала"><Link to="/materials">Материалы</Link><span>›</span><span>{m.title}</span></nav><div className={u.titleRow}><h1 className={s.title}>{m.title}</h1>{manageable && <button type="button" className={u.pencil} aria-label="Редактировать материал" title="Редактировать материал" onClick={() => setEditing(id)}><Glyph name="edit" /></button>}</div>{m.description && <p className={s.description}>{m.description}</p>}</div></BrandedHeader>
        <Card className={u.reading}>
          {m.placeholder && m.community_url && <a className={s.linkButton} href={m.community_url} target="_blank" rel="noopener noreferrer">Сообщество блока</a>}
          {m.published_content ? <MaterialContent body={m.published_content.body} /> : <Empty>Материал ещё готовится. Опубликованный текст появится здесь.</Empty>}
          {m.original_link && <a className={s.linkButton} href={m.original_link} target="_blank" rel="noopener noreferrer">Открыть оригинал</a>}
        </Card>
        {m.audience && <div className={u.audience}><MaterialAudience material={m} /></div>}
        <Link className={s.linkButton} to="/materials">Все материалы</Link>
      </>)}
    </QueryState>
  </section>;
}
