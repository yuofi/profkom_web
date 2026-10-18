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
                    { value: "kmb", label: "КМБ" },
                    { value: "guide", label: "Гайд" },
                    { value: "general", label: "Общий документ" },
                  ],
                },
                {
                  name: "block",
                  label: "Блок — для гайда",
                  type: "select",
                  options: blocks.data
                    ?.filter((b) => can(b, "edit_block"))
                    .map((b) => ({ value: b.block_id, label: b.name })),
                },
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
      </div>
    </Page>
  );
}
function MaterialEdit({ material: m }: { material: Material }) {
  const [body, setBody] = useState(
    m.draft_content?.body ?? m.published_content?.body ?? "",
  );
  const { perform, refresh } = useWorkspaceActions();
  return (
    <Card title="Редактирование материала">
      <p>
        Изменения сохраняются в черновик. Чтобы обновить текст для читателей,
        опубликуйте сохранённый черновик.
      </p>
      <ActionForm
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
        onSubmit={async (v) => {
          await perform(() =>
            materialsApi.update(m.material_id, {
              expected_revision: m.revision,
              title: text(v, "title"),
              description: text(v, "description"),
              original_link: text(v, "original") || null,
              content: richText(body),
            }),
          );
        }}
        submitLabel="Сохранить черновик"
        onConflict={() => {
          void refresh();
        }}
      >
        <MarkdownEditor value={body} onChange={setBody} />
      </ActionForm>
      {can(m, "publish_material") && m.draft_content && (
        <ActionForm
          fields={[]}
          submitLabel="Опубликовать сохранённый черновик"
          onSubmit={async () => {
            await perform(() =>
              materialsApi.publish(m.material_id, {
                expected_revision: m.revision,
              }),
            );
          }}
          onConflict={() => {
            void refresh();
          }}
        />
      )}
    </Card>
  );
}
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
            {can(m, "edit_material") && (
              <MaterialEdit material={m} key={m.material_id} />
            )}
            {can(m, "delete_material") && (
              <details className={s.details}>
                <summary>Удалить материал</summary>
                <p>
                  Удаляются опубликованный текст и черновик этого материала.
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
                    fields={[
                      {
                        name: "users",
                        label: "Редакторы",
                        type: "multi",
                        options: people.options,
                      },
                    ]}
                    onSubmit={async (v) => {
                      await perform(() =>
                        materialsApi.editors(id, ids(v, "users"), {
                          expected_revision: m.revision,
                        }),
                      );
                    }}
                    submitLabel="Установить состав редакторов"
                  />
                </Card>
              )}
          </div>
        )}
      </QueryState>
    </Page>
  );
}
