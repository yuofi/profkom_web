import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import {
  Page,
  Card,
  QueryState,
  Markdown,
  RouteLink,
  Badge,
  Empty,
} from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text, number } from "../../components/Workspace/formValues";
import { membershipApi } from "../../utils/api/membership.api";
import { eventsApi } from "../../utils/api/events.api";
import { richText, type BlockRequest } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { displayDate } from "../../utils/dates";
import {
  usePeopleOptions,
  useWorkspaceActions,
} from "../../utils/hooks/useWorkspace";
import { Leaders } from "./EventPages";
import s from "../../components/Workspace/Workspace.module.css";
const requestStates = {
  pending_hr: "На рассмотрении HR",
  pending_block: "На рассмотрении мастера блока",
  approved: "Одобрена",
  rejected: "Отклонена",
  withdrawn: "Отозвана",
};
export function BlocksPage() {
  const query = useQuery({
    queryKey: ["workspaceBlocks"],
    queryFn: membershipApi.blocks,
  });
  return (
    <Page
      title="Блоки"
      actions={
        <RouteLink to="/blocks/requests">Мои заявки и решения</RouteLink>
      }
    >
      <QueryState loading={query.isLoading} error={query.error}>
        <div className={s.grid}>
          {query.data?.map((b) => (
            <Card key={b.block_id} title={b.name}>
              <Markdown content={b.description} />
              <p>Мастер: {b.master?.user.display_name ?? "не назначен"}</p>
              <RouteLink to={`/blocks/${encodeURIComponent(b.block_id)}`}>
                О блоке
              </RouteLink>
            </Card>
          ))}
        </div>
      </QueryState>
    </Page>
  );
}
export function BlockPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const people = usePeopleOptions();
  const { perform, refresh } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["workspaceBlocks", id],
    queryFn: () => membershipApi.block(id),
  });
  const b = query.data;
  const requests = useQuery({
    queryKey: ["blockRequests"],
    queryFn: membershipApi.requests,
  });
  const pending = requests.data?.items.find(
    (r) =>
      r.block_id === id &&
      r.user.user_id === session?.user_id &&
      ["pending_hr", "pending_block"].includes(r.state),
  );
  return (
    <Page
      title={b?.name ?? "Блок"}
      actions={<RouteLink to="/blocks">Все блоки</RouteLink>}
    >
      <div className={s.tabs}>
        <RouteLink to={`/blocks/${encodeURIComponent(id)}`}>О блоке</RouteLink>
        <RouteLink
          to={`/tasks?scope_kind=block&scope_id=${encodeURIComponent(id)}`}
        >
          Задачи
        </RouteLink>
      </div>
      <QueryState loading={query.isLoading} error={query.error}>
        {b && (
          <div className={s.stack}>
            <Card>
              <Markdown content={b.description} />
              <div className={s.row}>
                {b.guide_material_id ? (
                  <RouteLink
                    to={`/materials/${encodeURIComponent(b.guide_material_id)}`}
                  >
                    Гайд блока
                  </RouteLink>
                ) : (
                  <span className={s.muted}>Гайд ещё готовится</span>
                )}
                {b.community_url && (
                  <a
                    href={b.community_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Сообщество блока
                  </a>
                )}
              </div>
            </Card>
            <Card title="Руководство">
              <Leaders leaders={b.master ? [b.master] : []} />
              {can(b, "manage_leaders") && (
                <ActionForm
                  key={b.revision}
                  fields={[
                    {
                      name: "user",
                      label: "Назначить мастера",
                      type: "select",
                      required: true,
                      value: b.master?.user.user_id
                        ? String(b.master.user.user_id)
                        : "",
                      options: people.options,
                    },
                  ]}
                  onSubmit={async (v) => {
                    await perform(() =>
                      eventsApi.blockLeader(id, number(v, "user"), {
                        expected_revision: b.revision,
                      }),
                    );
                  }}
                  onConflict={() => {
                    void refresh();
                  }}
                />
              )}
            </Card>
            <Card title="Состав блока">
              <ul className={s.list}>
                {b.members.map((m) => (
                  <li key={m.user.user_id}>
                    <div className={s.between}>
                      <span>
                        {m.user.display_name}{" "}
                        <Badge>
                          {m.block_category === "junior"
                            ? "Новичок блока"
                            : "Участник"}
                        </Badge>
                      </span>
                      {can(b, "remove_member") &&
                        m.user.user_id !== session?.user_id && (
                          <ActionForm
                            fields={[]}
                            submitLabel="Убрать из состава"
                            onSubmit={async () => {
                              await perform(() =>
                                membershipApi.remove(id, m.user.user_id!),
                              );
                            }}
                          />
                        )}
                    </div>
                  </li>
                ))}
              </ul>
              <p className={s.muted}>
                Служебное назначение мастера или заместителя отдельно от
                обычного членства.
              </p>
              {can(b, "leave_block") &&
              b.members.some((m) => m.user.user_id === session?.user_id) ? (
                <ActionForm
                  fields={[]}
                  submitLabel="Выйти из блока"
                  onSubmit={async () => {
                    await perform(() => membershipApi.leave(id));
                  }}
                />
              ) : pending ? (
                <p>
                  Заявка: {requestStates[pending.state]} ·{" "}
                  <RouteLink to="/blocks/requests">Открыть</RouteLink>
                </p>
              ) : (
                !b.members.some((m) => m.user.user_id === session?.user_id) && (
                  <ActionForm
                    fields={[]}
                    submitLabel="Подать заявку в блок"
                    onSubmit={async () => {
                      await perform(() => membershipApi.join(id));
                    }}
                  />
                )
              )}
            </Card>
            {can(b, "edit_block") && (
              <Card title="Изменить описание">
                <ActionForm
                  key={b.revision}
                  fields={[
                    {
                      name: "body",
                      label: "Описание",
                      type: "textarea",
                      value: b.description.body,
                    },
                    {
                      name: "url",
                      label: "Сообщество",
                      type: "url",
                      value: b.community_url ?? "",
                    },
                  ]}
                  onSubmit={async (v) => {
                    await perform(() =>
                      membershipApi.updateBlock(id, {
                        expected_revision: b.revision,
                        description: richText(text(v, "body")),
                        community_url: text(v, "url"),
                      }),
                    );
                  }}
                  onConflict={() => {
                    void refresh();
                  }}
                />
              </Card>
            )}
          </div>
        )}
      </QueryState>
    </Page>
  );
}
function RequestCard({
  request: r,
  blockName,
}: {
  request: BlockRequest;
  blockName: string;
}) {
  const { perform, refresh } = useWorkspaceActions();
  const open = ["pending_hr", "pending_block"].includes(r.state);
  const review = can(
    r,
    r.state === "pending_hr" ? "hr_review_request" : "block_review_request",
  );
  return (
    <Card title={`${r.user.display_name} → ${blockName}`}>
      <Badge>{requestStates[r.state]}</Badge>
      <p>Текущий этап с {displayDate(r.stage_entered_at)}</p>
      {r.substitute_available_at && (
        <p className={s.muted}>
          Срок для подмены руководства: {displayDate(r.substitute_available_at)}{" "}
          (72 часа текущего этапа). Доступность решения определяет сервер.
        </p>
      )}
      {open && review && (
        <div className={s.stack}>
          <ActionForm
            fields={[]}
            submitLabel={
              r.state === "pending_hr"
                ? "Одобрить этап HR"
                : "Одобрить вступление"
            }
            onSubmit={async () => {
              await perform(() =>
                membershipApi.requestCommand(
                  r.request_id,
                  r.state === "pending_hr" ? "hr-approve" : "block-approve",
                  { expected_revision: r.revision },
                ),
              );
            }}
            onConflict={() => {
              void refresh();
            }}
          />
          <ActionForm
            fields={[
              {
                name: "reason",
                label: "Причина отказа",
                type: "textarea",
                required: true,
              },
            ]}
            submitLabel="Отклонить"
            onSubmit={async (v) => {
              await perform(() =>
                membershipApi.requestCommand(r.request_id, "reject", {
                  expected_revision: r.revision,
                  reason: text(v, "reason"),
                }),
              );
            }}
          />
        </div>
      )}
      {open && can(r, "withdraw_request") && (
        <ActionForm
          fields={[]}
          submitLabel="Отозвать свою заявку"
          onSubmit={async () => {
            await perform(() =>
              membershipApi.requestCommand(r.request_id, "withdraw", {
                expected_revision: r.revision,
              }),
            );
          }}
        />
      )}
    </Card>
  );
}
export function BlockRequestsPage() {
  const query = useQuery({
    queryKey: ["blockRequests"],
    queryFn: membershipApi.requests,
  });
  const blocks = useQuery({
    queryKey: ["workspaceBlocks"],
    queryFn: membershipApi.blocks,
  });
  return (
    <Page
      title="Заявки в блоки"
      description="Обычный блок: HR, затем мастер. В HR-блок вступление завершается после одного решения HR."
    >
      <QueryState loading={query.isLoading} error={query.error}>
        <div className={s.stack}>
          {query.data?.items.map((r) => (
            <RequestCard
              request={r}
              key={r.request_id}
              blockName={
                blocks.data?.find((b) => b.block_id === r.block_id)?.name ??
                "Блок"
              }
            />
          ))}
          {query.data?.items.length === 0 && <Empty>Заявок пока нет.</Empty>}
        </div>
      </QueryState>
    </Page>
  );
}
export function RegistrationsPage() {
  const { session } = useSession();
  const { perform, refresh } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["registrations", "queue"],
    queryFn: membershipApi.registrations,
    enabled: can(session, "review_registrations"),
  });
  if (!can(session, "review_registrations"))
    return (
      <Page title="Регистрации">
        <Empty>Нет доступа к заявкам.</Empty>
      </Page>
    );
  return (
    <Page title="Регистрации">
      <QueryState loading={query.isLoading} error={query.error}>
        {!can(session, "review_registrations") && (
          <Empty>Нет доступа к заявкам.</Empty>
        )}
        <div className={s.stack}>
          {query.data?.items.map((r) => (
            <Card
              key={r.user_id}
              title={`${r.fields.surname} ${r.fields.name}`}
            >
              <Badge>
                {r.status === "pending"
                  ? "Ожидает решения"
                  : r.status === "rejected"
                    ? "Отклонена"
                    : "Одобрена"}
              </Badge>
              <dl>
                {Object.entries(r.fields).map(([key, value]) => (
                  <div key={key}>
                    <dt>
                      {
                        (
                          {
                            surname: "Фамилия",
                            name: "Имя",
                            patronymic: "Отчество",
                            group_number: "Группа",
                            phone: "Телефон",
                            email: "Почта",
                            tg: "Telegram",
                            vk: "VK",
                            funding: "Основа обучения",
                            residence: "Место проживания",
                          } as Record<string, string>
                        )[key]
                      }
                    </dt>
                    <dd>{value || "—"}</dd>
                  </div>
                ))}
              </dl>
              <p>
                Отправок: {r.attempts_used}/5 · за всё время:{" "}
                {r.total_submissions}
              </p>
              {r.rejection_reason && <p>{r.rejection_reason}</p>}
              {r.status === "pending" && (
                <ActionForm
                  fields={[
                    {
                      name: "decision",
                      label: "Решение",
                      type: "select",
                      required: true,
                      options: [
                        { value: "approve", label: "Одобрить" },
                        { value: "reject", label: "Отклонить" },
                      ],
                    },
                    {
                      name: "reason",
                      label: "Причина отказа",
                      type: "textarea",
                    },
                  ]}
                  onSubmit={async (v) => {
                    if (text(v, "decision") === "reject" && !text(v, "reason"))
                      throw Error("Укажите причину отказа");
                    await perform(() =>
                      membershipApi.registrationCommand(
                        r.user_id,
                        text(v, "decision") as "approve" | "reject",
                        {
                          expected_revision: r.revision,
                          reason: text(v, "reason"),
                        },
                      ),
                    );
                  }}
                  onConflict={() => {
                    void refresh();
                  }}
                />
              )}
              {r.status !== "approved" &&
                can(r, "reset_registration_limit") && (
                  <ActionForm
                    fields={[
                      {
                        name: "reason",
                        label: "Основание сброса счётчика",
                        required: true,
                      },
                    ]}
                    submitLabel="Сбросить лимит"
                    onSubmit={async (v) => {
                      await perform(() =>
                        membershipApi.registrationCommand(
                          r.user_id,
                          "reset-attempts",
                          {
                            expected_revision: r.revision,
                            reason: text(v, "reason"),
                          },
                        ),
                      );
                    }}
                  />
                )}
            </Card>
          ))}
        </div>
      </QueryState>
    </Page>
  );
}
export function ParticipantCategoryPanel({ userId }: { userId: number }) {
  const { session } = useSession();
  const { perform } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["participantCategory", userId],
    queryFn: () => membershipApi.category(userId),
    enabled: can(session, "edit_participant_category"),
  });
  const category = query.data;
  if (!can(session, "edit_participant_category")) return null;
  return (
    <QueryState loading={query.isLoading} error={query.error}>
      {category && (
        <div>
          <p>
            Глобальная категория:{" "}
            {category.category === "junior" ? "Джуниор" : "Активист"}. Новичок
            отдельного блока — другая отметка.
          </p>
          {can(category, "edit_participant_category") && (
            <ActionForm
              key={category.revision}
              fields={[
                {
                  name: "category",
                  label: "Категория участника",
                  type: "select",
                  required: true,
                  value: category.category,
                  options: [
                    { value: "junior", label: "Джуниор" },
                    { value: "activist", label: "Активист" },
                  ],
                },
                {
                  name: "reason",
                  label: "Причина ручной смены",
                  type: "textarea",
                  required: true,
                },
              ]}
              onSubmit={async (v) => {
                await perform(() =>
                  membershipApi.updateCategory(userId, {
                    expected_revision: category.revision,
                    category: text(v, "category") as "junior" | "activist",
                    reason: text(v, "reason"),
                  }),
                );
              }}
            />
          )}
        </div>
      )}
    </QueryState>
  );
}
