import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  Page,
  Card,
  QueryState,
  RouteLink,
  Badge,
  Empty,
} from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { MarkdownContent } from "../../components/Workspace/MarkdownContent";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { text, ids } from "../../components/Workspace/formValues";
import { membershipApi } from "../../utils/api/membership.api";
import { materialsApi } from "../../utils/api/materials.api";
import { richText, type Material } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import {
  usePeopleOptions,
  useWorkspaceActions,
} from "../../utils/hooks/useWorkspace";
import s from "../../components/Workspace/Workspace.module.css";
export function MaterialsPage() {
  const { session } = useSession();
  const navigate = useNavigate();
  const { perform } = useWorkspaceActions();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const query = useQuery({
    queryKey: ["materials"],
    queryFn: materialsApi.list,
  });
  const blocks = useQuery({
    queryKey: ["workspaceBlocks"],
    queryFn: membershipApi.blocks,
  });
  // КМБ and shared documents belong to the chair and deputies; a guide to its block's leads.
  const shared = can(session, "create_shared_material");
  const guideBlocks = (blocks.data ?? []).filter((b) => can(b, "edit_block"));
  const visibleItems = (query.data?.items ?? []).filter((m) =>
    (!kind || m.kind === kind) && `${m.title} ${m.description}`.toLocaleLowerCase("ru").includes(search.trim().toLocaleLowerCase("ru")),
  );
  const clearFilters = () => { setSearch(""); setKind(""); };
  return (
    <Page
      title="Материалы"
      description="КМБ, гайды и полезные документы для работы."
    >
      <div className={s.stack}>
        <div className={s.row}>
          <RouteLink to="/guides">Ранее сохранённые гайды</RouteLink>
          <RouteLink to="/pgas">ПГАС</RouteLink>
        </div>
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
          <div className={s.grid}>
            {visibleItems.map((m) => (
                <Card key={m.material_id} title={m.title}>
                  <Badge>
                    {m.kind === "kmb"
                      ? "КМБ"
                      : m.kind === "guide"
                        ? "Гайд"
                        : "Документ"}
                  </Badge>
                  {m.audience === "block" && <Badge>Для участников блока</Badge>}
                  <p>{m.description}</p>
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
        {can(session, "create_material") && (
          <Card title="Новый материал">
            <ActionForm
              fields={[
                { name: "title", label: "Название", required: true },
                {
                  name: "description",
                  label: "Краткое описание",
                  required: true,
                },
                {
                  name: "kind",
                  label: "Раздел",
                  type: "select",
                  required: true,
                  options: [
                    ...(shared ? [{ value: "kmb", label: "КМБ" }] : []),
                    ...(guideBlocks.length ? [{ value: "guide", label: "Гайд" }] : []),
                    ...(shared ? [{ value: "general", label: "Общий документ" }] : []),
                  ],
                },
                ...(guideBlocks.length
                  ? [
                      {
                        name: "block",
                        label: "Блок — для гайда",
                        type: "select" as const,
                        options: guideBlocks.map((b) => ({ value: b.block_id, label: b.name })),
                      },
                    ]
                  : []),
              ]}
              onSubmit={async (v) => {
                if (text(v, "kind") === "guide" && !text(v, "block"))
                  throw Error("Выберите блок для гайда");
                await perform(async () => {
                  const m = await materialsApi.create({
                    title: text(v, "title"),
                    description: text(v, "description"),
                    kind: text(v, "kind"),
                    ...(text(v, "kind") === "guide"
                      ? { owner_block_id: text(v, "block") }
                      : {}),
                    content: richText(""),
                  });
                  navigate(`/materials/${encodeURIComponent(m.material_id)}`);
                });
              }}
              submitLabel="Создать черновик"
            />
          </Card>
        )}
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
function MaterialEdit({ material: m }: { material: Material }) {
  // Never edit published_content: its links are signed for 5 minutes (A-MAT-1).
  const source = m.source_content?.body ?? "";
  const [body, setBody] = useState(source);
  const { perform, refresh } = useWorkspaceActions();
  return (
    <Card title="Редактирование материала">
      <p>
        Изменения сохраняются в черновик. Чтобы обновить текст для читателей,
        опубликуйте сохранённый черновик.
      </p>
      <ActionForm
        revision={m.revision}
        record={`material:${m.material_id}`}
        savedDetails={<MarkdownContent body={source} />}
        onReplaceWithSaved={() => setBody(source)}
        fields={[
          { name: "title", label: "Название", required: true, value: m.title },
          { name: "description", label: "Описание", value: m.description },
          {
            name: "original",
            label: "Ссылка на оригинал",
            type: "url",
            value: m.original_link ?? "",
          },
        ]}
        onSubmit={async (v, expectedRevision) => {
          return perform(() =>
            materialsApi.update(m.material_id, {
              expected_revision: expectedRevision!,
              title: text(v, "title"),
              description: text(v, "description"),
              original_link: text(v, "original") || null,
              content: richText(body),
            }),
          );
        }}
        submitLabel="Сохранить черновик"
        onConflict={refresh}
      >
        <MarkdownEditor value={body} onChange={setBody} />
      </ActionForm>
      {can(m, "publish_material") && (
        <ActionForm
          revision={m.revision}
          record={`material:${m.material_id}`}
          disabled={!m.draft_content}
          savedDetails={<MarkdownContent body={source} />}
          fields={[]}
          submitLabel="Опубликовать сохранённый черновик"
          onSubmit={async (_v, expectedRevision) => {
            return perform(() =>
              materialsApi.publish(m.material_id, {
                expected_revision: expectedRevision!,
              }),
            );
          }}
          onConflict={refresh}
        />
      )}
    </Card>
  );
}
/** Who reads a block guide (owner, 2026-10-25). */
const AUDIENCE = {
  block: "Только участники блока, его мастер и замы, председатель и замы",
  everyone: "Все участники Профкома",
} as const;
export function MaterialPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const people = usePeopleOptions();
  const { perform, refresh } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["materials", id],
    queryFn: () => materialsApi.get(id),
  });
  const m = query.data;
  return (
    <Page
      title={m?.title ?? "Материал"}
      actions={<RouteLink to="/materials">Все материалы</RouteLink>}
    >
      <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
        {m && (
          <div className={s.stack}>
            <Card>
              {m.published_content ? (
                <MarkdownContent body={m.published_content.body} />
              ) : (
                <Empty>
                  Материал ещё готовится. Опубликованный текст появится здесь.
                </Empty>
              )}
              {m.original_link && (
                <a
                  href={m.original_link}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Открыть оригинал
                </a>
              )}
            </Card>
            {m.audience && !can(m, "edit_audience") && (
              <p className={s.muted}>{AUDIENCE[m.audience]}</p>
            )}
            {m.audience && can(m, "edit_audience") && (
              <Card title="Кто видит гайд">
                <ActionForm
                  revision={m.revision}
                  record={`material-audience:${m.material_id}`}
                  fields={[
                    {
                      name: "audience",
                      label: "Читатели",
                      type: "select",
                      value: m.audience,
                      options: Object.entries(AUDIENCE).map(([value, label]) => ({ value, label })),
                    },
                  ]}
                  submitLabel="Сохранить"
                  onSubmit={async (v, expectedRevision) =>
                    perform(() =>
                      materialsApi.audience(id, text(v, "audience") as "block" | "everyone", {
                        expected_revision: expectedRevision!,
                      }),
                    )
                  }
                  onConflict={refresh}
                />
              </Card>
            )}
            {can(m, "edit_material") && (
              <MaterialEdit material={m} key={m.material_id} />
            )}
            {can(m, "delete_material") && (
              <details className={s.details}>
                <summary>Удалить материал</summary>
                <p>
                  Материал вместе с черновиком скроется у всех читателей.
                  Председатель и замы могут его восстановить.
                </p>
                <ActionForm
                  fields={[]}
                  submitLabel="Удалить материал"
                  onSubmit={async () => {
                    await materialsApi.remove(id);
                    navigate("/materials", { replace: true });
                    await refresh();
                  }}
                />
              </details>
            )}
            {m.owner_block_id === null &&
              can(session, "manage_material_editors") && (
                <Card title="Редакторы общего материала">
                  <p>
                    Выберите полный состав редакторов. Этот список заменит
                    прежние назначения данного материала.
                  </p>
                  <ActionForm
                    revision={m.revision}
                    record={`material:${m.material_id}`}
                    fields={[
                      {
                        name: "users",
                        label: "Редакторы",
                        type: "multi",
                        value: m.editor_user_ids?.map(String) ?? [],
                        options: people.options,
                      },
                    ]}
                    onSubmit={async (v, expectedRevision) => {
                      return perform(() =>
                        materialsApi.editors(id, ids(v, "users"), {
                          expected_revision: expectedRevision!,
                        }),
                      );
                    }}
                    submitLabel="Установить состав редакторов"
                    onConflict={refresh}
                  />
                </Card>
              )}
          </div>
        )}
      </QueryState>
    </Page>
  );
}
