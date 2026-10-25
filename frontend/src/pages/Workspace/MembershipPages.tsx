import { useState } from "react";
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
import type { Tone } from "../../components/Workspace/sections";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { fundingLabels, registrationLabels } from "../../utils/contactFields";
import { text, number } from "../../components/Workspace/formValues";
import { membershipApi } from "../../utils/api/membership.api";
import { eventsApi } from "../../utils/api/events.api";
import { richText, type BlockRequest } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { displayDate, waited } from "../../utils/dates";
import { useDeadlineRefresh } from "../../utils/hooks/useDeadlineRefresh";
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
const requestTones: Record<BlockRequest["state"], Tone | undefined> = {
  pending_hr: "peach",
  pending_block: "peach",
  approved: "mint",
  rejected: "rose",
  withdrawn: undefined,
};
const isOpen = (r: BlockRequest) => ["pending_hr", "pending_block"].includes(r.state);
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
      <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
        <div className={s.grid}>
          {query.data?.map((b) => (
            <Card key={b.block_id} title={b.name}>
              <Markdown content={b.description} preview />
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
  const canViewTracker = can(b, "view_tasks");
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
      <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
        {b && (
          <div className={s.stack}>
            <Card>
              <div className={s.row}>
                {canViewTracker && (
                  <RouteLink
                    to={`/tasks?scope_kind=block&scope_id=${encodeURIComponent(id)}`}
                  >
                    Задачи блока
                  </RouteLink>
                )}
                {can(b, "create_volunteer_merit") && <RouteLink to={`/merits?source_kind=block_volunteer&scope_id=${encodeURIComponent(id)}`}>Учесть волонтёрскую работу</RouteLink>}
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
                    className={s.linkButton}
                    href={b.community_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Сообщество блока
                  </a>
                )}
              </div>
              <Markdown content={b.description} />
            </Card>
            <Card title="Руководство">
              <Leaders leaders={b.master ? [b.master] : []} />
              {can(b, "manage_leaders") && (
                <ActionForm
                  key={b.block_id}
                  revision={b.revision}
                  record={`block:${b.block_id}`}
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
                  onSubmit={async (v, expectedRevision) => {
                    return perform(() =>
                      eventsApi.blockLeader(id, number(v, "user"), {
                        expected_revision: expectedRevision!,
                      }),
                    );
                  }}
                  onConflict={refresh}
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
                        <Badge tone={m.block_category === "junior" ? "mint" : undefined}>
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
                            variant="danger"
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
                  variant="danger"
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
                  key={b.block_id}
                  revision={b.revision}
                  record={`block:${b.block_id}`}
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
                  onSubmit={async (v, expectedRevision) => {
                    return perform(() =>
                      membershipApi.updateBlock(id, {
                        expected_revision: expectedRevision!,
                        description: richText(text(v, "body")),
                        community_url: text(v, "url"),
                      }),
                    );
                  }}
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
      <Badge tone={requestTones[r.state]}>{requestStates[r.state]}</Badge>
      {open ? (
        <p>
          Текущий этап с {displayDate(r.stage_entered_at)} ·{" "}
          <span className={s.nowrap}>ждёт {waited(r.stage_entered_at)}</span>
        </p>
      ) : (
        r.decided_at && <p>Решение: {displayDate(r.decided_at)}</p>
      )}
      {r.state === "rejected" && r.decision_reason && (
        <p>Причина отказа: {r.decision_reason}</p>
      )}
      {r.substitute_available_at && (
        <p className={s.muted}>
          Срок для подмены руководства: {displayDate(r.substitute_available_at)}{" "}
          (72 часа текущего этапа). Доступность решения определяет сервер.
        </p>
      )}
      {open && review && (
        <div className={s.stack}>
          <ActionForm
            revision={r.revision}
            record={`block-request:${r.request_id}`}
            onConflict={refresh}
            fields={[]}
            submitLabel={
              r.state === "pending_hr"
                ? "Одобрить этап HR"
                : "Одобрить вступление"
            }
            onSubmit={async (_v, expectedRevision) => {
              return perform(() =>
                membershipApi.requestCommand(
                  r.request_id,
                  r.state === "pending_hr" ? "hr-approve" : "block-approve",
                  { expected_revision: expectedRevision! },
                ),
              );
            }}
          />
          <details className={s.details}>
            <summary>Отклонить с причиной</summary>
            <ActionForm
              revision={r.revision}
              record={`block-request:${r.request_id}`}
              onConflict={refresh}
              fields={[
                {
                  name: "reason",
                  label: "Причина отказа",
                  type: "textarea",
                  required: true,
                },
              ]}
              submitLabel="Отклонить"
              variant="danger"
              onSubmit={async (v, expectedRevision) => {
                return perform(() =>
                  membershipApi.requestCommand(r.request_id, "reject", {
                    expected_revision: expectedRevision!,
                    reason: text(v, "reason"),
                  }),
                );
              }}
            />
          </details>
        </div>
      )}
      {open && can(r, "withdraw_request") && (
        <ActionForm
            revision={r.revision}
            record={`block-request:${r.request_id}`}
            onConflict={refresh}
          fields={[]}
          submitLabel="Отозвать свою заявку"
          variant="danger"
          onSubmit={async (_v, expectedRevision) => {
            return perform(() =>
              membershipApi.requestCommand(r.request_id, "withdraw", {
                expected_revision: expectedRevision!,
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
    refetchOnWindowFocus: "always",
    refetchInterval: (query) =>
      query.state.data?.items.some((r) =>
        ["pending_hr", "pending_block"].includes(r.state),
      )
        ? 60_000
        : false,
  });
  useDeadlineRefresh(
    query.data?.items
      .filter((r) => ["pending_hr", "pending_block"].includes(r.state))
      .flatMap((r) =>
        r.substitute_available_at ? [r.substitute_available_at] : [],
      ) ?? [],
    query.refetch,
  );
  const blocks = useQuery({
    queryKey: ["workspaceBlocks"],
    queryFn: membershipApi.blocks,
  });
  const { session } = useSession();
  // Each request in one section: my decisions first, then my own, the rest, history (A-ROL-3).
  const sections: [string, BlockRequest[]][] = [
    ["Этап HR — моё решение", []],
    ["Этап мастера — моё решение", []],
    ["Мои заявки", []],
    ["Прочие открытые", []],
    ["История", []],
  ];
  for (const r of query.data?.items ?? []) {
    const index = can(r, "hr_review_request") ? 0 : can(r, "block_review_request") ? 1
      : r.user.user_id === session?.user_id ? 2 : isOpen(r) ? 3 : 4;
    sections[index][1].push(r);
  }
  const card = (r: BlockRequest) => (
    <RequestCard
      request={r}
      key={r.request_id}
      blockName={blocks.data?.find((b) => b.block_id === r.block_id)?.name ?? "Блок"}
    />
  );
  return (
    <Page
      title="Заявки в блоки"
      description="Обычный блок: HR, затем мастер. В HR-блок вступление завершается после одного решения HR."
      actions={
        <button
          className={s.button}
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Обновить заявки
        </button>
      }
    >
      <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
        <div className={s.stack}>
          {sections.map(([title, items]) =>
            items.length === 0 ? null : title === "История" ? (
              <details key={title} className={s.details}>
                <summary>История · {items.length}</summary>
                <div className={s.stack}>{items.map(card)}</div>
              </details>
            ) : (
              <section key={title} aria-label={title} className={s.stack}>
                <h2>{title}</h2>
                {items.map(card)}
              </section>
            ),
          )}
          {query.data?.items.length === 0 && <Empty>Заявок пока нет.</Empty>}
        </div>
      </QueryState>
    </Page>
  );
}
const registrationStatuses = {
  pending: "Ожидают решения",
  rejected: "Отклонённые",
  approved: "Одобренные",
} as const;
type RegistrationStatus = keyof typeof registrationStatuses;
export function RegistrationsPage() {
  const { session } = useSession();
  const { perform, refresh } = useWorkspaceActions();
  // The waiting ones open first (A-ROL-21); "" lists every status, waiting first.
  const [status, setStatus] = useState<RegistrationStatus | "">("pending");
  const query = useQuery({
    queryKey: ["registrations", "queue", status],
    queryFn: () => membershipApi.registrations(status || undefined),
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
      <label>
        Показать{" "}
        <select name="status" value={status} onChange={(e) => setStatus(e.target.value as RegistrationStatus | "")}>
          {Object.entries(registrationStatuses).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
          <option value="">Все</option>
        </select>
      </label>
      <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
        <div className={s.stack}>
          {query.data?.items.length === 0 && (
            <Empty>{status ? `${registrationStatuses[status]}: заявок нет.` : "Заявок нет."}</Empty>
          )}
          {query.data?.items.map((r) => (
            <Card
              key={r.user_id}
              title={`${r.fields.surname} ${r.fields.name}`}
            >
              <Badge tone={r.status === "pending" ? "peach" : r.status === "rejected" ? "rose" : "mint"}>
                {r.status === "pending"
                  ? "Ожидает решения"
                  : r.status === "rejected"
                    ? "Отклонена"
                    : "Одобрена"}
              </Badge>
              <dl>
                {Object.entries(registrationLabels).map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{r.fields[key as keyof typeof registrationLabels] || "—"}</dd>
                  </div>
                ))}
                <div>
                  <dt>Основа обучения</dt>
                  <dd>{r.fields.funding ? fundingLabels[r.fields.funding] : "Не выбрано"}</dd>
                </div>
              </dl>
              <p>
                Отправок: {r.attempts_used}/{r.attempt_limit} · за всё время:{" "}
                {r.total_submissions}
              </p>
              {r.rejection_reason && <p>{r.rejection_reason}</p>}
              {r.status === "pending" && (
                <ActionForm
                    revision={r.revision}
                    record={`registration:${r.user_id}`}
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
                  onSubmit={async (v, expectedRevision) => {
                    if (text(v, "decision") === "reject" && !text(v, "reason"))
                      throw Error("Укажите причину отказа");
                    return perform(() =>
                      membershipApi.registrationCommand(
                        r.user_id,
                        text(v, "decision") as "approve" | "reject",
                        {
                          expected_revision: expectedRevision!,
                          reason: text(v, "reason"),
                        },
                      ),
                    );
                  }}
                  onConflict={refresh}
                />
              )}
              {r.status !== "approved" &&
                can(r, "reset_registration_limit") && (
                  <details className={s.details}>
                    <summary>Сбросить лимит отправок</summary>
                    <ActionForm
                      revision={r.revision}
                      record={`registration:${r.user_id}`}
                      fields={[
                        {
                          name: "reason",
                          label: "Основание сброса счётчика",
                          required: true,
                        },
                      ]}
                      submitLabel="Сбросить лимит"
                      variant="quiet"
                      onConflict={refresh}
                      onSubmit={async (v, expectedRevision) => {
                        return perform(() =>
                          membershipApi.registrationCommand(
                            r.user_id,
                            "reset-attempts",
                            {
                              expected_revision: expectedRevision!,
                              reason: text(v, "reason"),
                            },
                          ),
                        );
                      }}
                    />
                  </details>
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
  const { perform, refresh } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["participantCategory", userId],
    queryFn: () => membershipApi.category(userId),
    enabled: can(session, "edit_participant_category"),
  });
  const category = query.data;
  if (!can(session, "edit_participant_category")) return null;
  return (
    <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
      {category && (
        <div>
          <p>
            Глобальная категория:{" "}
            {category.category === "junior" ? "Джуниор" : "Активист"}. Новичок
            отдельного блока — другая отметка.
          </p>
          {can(category, "edit_participant_category") && (
            <ActionForm
              key={category.user_id}
              revision={category.revision}
              changeRequired={["category"]}
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
              onSubmit={async (v, expectedRevision) => {
                return perform(() =>
                  membershipApi.updateCategory(userId, {
                    expected_revision: expectedRevision!,
                    category: text(v, "category") as "junior" | "activist",
                    reason: text(v, "reason"),
                  }),
                );
              }}
              onConflict={refresh}
            />
          )}
        </div>
      )}
    </QueryState>
  );
}
