import { BlockChip } from "../../components/Workspace/BlockChip";
import { UserChip } from "../../components/Workspace/UserChip";
import { BlockAvatarPicker } from "../../components/Workspace/BlockAvatarPicker";
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
import { sessionApi } from "../../utils/api/session.api";
import { directoryApi } from "../../utils/api/directory.api";
import { canRetainData } from "../../utils/api/request";
import { richText, type BlockRequest, type RegistrationApplication } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { displayDate, waited } from "../../utils/dates";
import { useDeadlineRefresh } from "../../utils/hooks/useDeadlineRefresh";
import {
  usePeopleOptions,
  useWorkspaceActions,
} from "../../utils/hooks/useWorkspace";
import { Leaders } from "./EventLeaders";
import { OrganizationTree } from "./OrganizationTree";
import { BlockHr } from "./BlockHr";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { userMessage } from "../../utils/api/messages";
import m from "./MembershipPages.module.css";
import { HistoryDisclosure } from "../../components/Workspace/HistoryPanel";
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
  const { session } = useSession();
  const enabled = session?.account_state === "active" && session.registration_status === "approved";
  const query = useQuery({
    queryKey: ["workspaceBlocks"],
    queryFn: membershipApi.blocks,
    enabled,
  });
  const leadership = useQuery({ queryKey: ["leadership"], queryFn: sessionApi.leadership, enabled });
  const people = useQuery({ queryKey: ["contacts"], queryFn: directoryApi.contacts, enabled });
  const errors = [query.error, leadership.error, people.error].filter(Boolean);
  const error = errors.find(item => !canRetainData(item)) ?? errors[0];
  const ready = !!query.data && !!leadership.data && !!people.data;
  return (
    <Page
      title="Блоки"
      description="Структура Профкома: руководство, мастера блоков и участники."
      actions={
        <RouteLink to="/blocks/requests">{can(session, "view_block_requests") ? "Заявки в блоки" : "Мои заявки и решения"}</RouteLink>
      }
    >
      <QueryState keepDataOnError={ready}
        loading={query.isLoading || leadership.isLoading || people.isLoading} error={error}
        retry={() => { void query.refetch();void leadership.refetch();void people.refetch(); }}>
        {enabled && ready && <OrganizationTree blocks={query.data!} leadership={leadership.data!} people={people.data!.map(person => ({ user_id: person.user_id, display_name: [person.surname, person.name, person.patronymic].filter(Boolean).join(" "), avatar_url: person.photo_url ?? null }))} />}
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
  const b = !query.error || canRetainData(query.error) ? query.data : undefined;
  const canViewTracker = can(b, "view_tasks");
  const alreadyInBlock = !!b && !!session && (b.members.some(member => member.user.user_id === session.user_id) || b.master?.user.user_id === session.user_id || !!b.master?.deputy_user_ids.includes(session.user_id));
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
      actions={<div className={s.row}>{b && <BlockAvatarPicker block={b} />}<RouteLink to="/blocks">Все блоки</RouteLink></div>}
    >
      <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
        {b && (
          <div className={s.stack}>
            <Card>
              <div className={s.row}>
                <BlockChip block={b} interactive={false} />
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
            <Card title="HR блока"><BlockHr block={b} /></Card>
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
                        m.user.user_id !== session?.user_id && m.user.user_id !== b.master?.user.user_id && !b.master?.deputy_user_ids.includes(m.user.user_id!) && (
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
              {alreadyInBlock ? null : pending ? (
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
            <HistoryDisclosure kind="block" id={id} />
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
      <div className={s.row}><Badge tone={requestTones[r.state]}>{requestStates[r.state]}</Badge>{open && <RouteLink to={`/blocks/${encodeURIComponent(r.block_id)}`}>Открыть блок</RouteLink>}</div>
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
      {(r.approvals?.length ?? 0) > 0 ? (
        <div className={s.stack} role="group" aria-label="Одобрения заявки">
          <strong>Кто одобрил</strong>
          {r.approvals.map((approval, index) => <p className={s.row} key={`${approval.stage}-${index}`}>
            <span>{approval.stage === "hr" ? "Этап HR" : "Этап блока"}:</span>
            {approval.actor ? <UserChip user={approval.actor} /> : <span className={s.muted}>Автор неизвестен или архивирован</span>}
            <small>{approval.at ? displayDate(approval.at) : "Дата не записана"}</small>
            {approval.substitute && <Badge>Подмена руководства</Badge>}
          </p>)}
        </div>
      ) : r.state === "approved" && <p className={s.muted}>Кто одобрил: сведения не сохранены.</p>}
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

    >
      <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>
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
function RegistrationCard({ registration: r }: { registration: RegistrationApplication }) {
  const { perform, refresh } = useWorkspaceActions();
  const [expanded, setExpanded] = useState(false), [rejecting, setRejecting] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const approve = async () => {
    if (busy) return;
    setBusy(true);setError("");
    try { await perform(() => membershipApi.registrationCommand(r.user_id, "approve", { expected_revision: r.revision })); }
    catch (failure) { setError(userMessage(failure));await refresh(); }
    finally { setBusy(false); }
  };
  return <Card className={m.registrationCard}>
    <details className={m.registrationDetails} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary><div><strong>{r.fields.surname} {r.fields.name} {r.fields.patronymic}</strong><small>{[r.fields.group_number, r.fields.email].filter(Boolean).join(" · ")}</small></div><Badge tone={r.status === "pending" ? "peach" : r.status === "rejected" ? "rose" : "mint"}>{r.status === "pending" ? "Ожидает решения" : r.status === "rejected" ? "Отклонена" : "Одобрена"}</Badge></summary>
      {expanded && <div className={m.registrationBody}>
        <dl className={m.registrationFields}>{Object.entries(registrationLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{r.fields[key as keyof typeof registrationLabels] || "—"}</dd></div>)}<div><dt>Основа обучения</dt><dd>{r.fields.funding ? fundingLabels[r.fields.funding] : "Не выбрано"}</dd></div></dl>
        <p className={s.muted}>Отправок: {r.attempts_used}/{r.attempt_limit} · за всё время: {r.total_submissions}</p>
        {r.rejection_reason && <p>Причина отказа: {r.rejection_reason}</p>}
        {r.status !== "approved" && can(r, "reset_registration_limit") && <details className={s.details}><summary>Сбросить лимит отправок</summary><ActionForm revision={r.revision} record={`registration:${r.user_id}`} fields={[{ name: "reason", label: "Основание сброса счётчика", required: true }]} submitLabel="Сбросить лимит" variant="quiet" onConflict={refresh} onSubmit={async (values, revision) => perform(() => membershipApi.registrationCommand(r.user_id, "reset-attempts", { expected_revision: revision!, reason: text(values, "reason") }))} /></details>}
      </div>}
    </details>
    {r.status === "pending" && <div className={m.decisions}><button type="button" className={s.button} aria-busy={busy} disabled={busy} onClick={() => void approve()}>Одобрить</button><button type="button" className={`${s.button} ${m.reject}`} disabled={busy} onClick={() => setRejecting(true)}>Отклонить</button></div>}
    {error && <p role="alert" className={s.error}>{error}</p>}
    {rejecting && r.status === "pending" && <UnsavedChangesScope><TrackerTaskDialog title="Отклонить регистрацию" onClose={() => setRejecting(false)}><p>{r.fields.surname} {r.fields.name}</p><ActionForm revision={r.revision} record={`registration:${r.user_id}`} fields={[{ name: "reason", label: "Причина отказа", type: "textarea", required: true }]} submitLabel="Отклонить регистрацию" variant="danger" onConflict={refresh} onSubmit={async (values, revision) => { const saved = await perform(() => membershipApi.registrationCommand(r.user_id, "reject", { expected_revision: revision!, reason: text(values, "reason") }));setRejecting(false);return saved; }} /></TrackerTaskDialog></UnsavedChangesScope>}
  </Card>;
}
export function RegistrationsPage() {
  const { session } = useSession();
  const [status, setStatus] = useState<RegistrationStatus | "">("pending");
  const query = useQuery({ queryKey: ["registrations", "queue", status], queryFn: () => membershipApi.registrations(status || undefined), enabled: can(session, "review_registrations") });
  if (!can(session, "review_registrations")) return <Page title="Регистрации"><Empty>Нет доступа к заявкам.</Empty></Page>;
  return <Page title="Регистрации" description="Одобрите заявку или раскройте карточку, чтобы проверить данные.">
    <div className={m.statusTabs} role="group" aria-label="Статус регистраций">{[...Object.entries(registrationStatuses), ["", "Все"]].map(([value, label]) => <button type="button" key={value} className={s.button} aria-pressed={status === value} onClick={() => setStatus(value as RegistrationStatus | "")}>{label}</button>)}</div>
    <QueryState keepDataOnError={!!query.data} loading={query.isLoading} error={query.error}><div className={s.stack}>
      {query.data?.items.length === 0 && <Empty>{status ? `${registrationStatuses[status]}: заявок нет.` : "Заявок нет."}</Empty>}
      {query.data?.items.map(registration => <RegistrationCard key={registration.user_id} registration={registration} />)}
    </div></QueryState>
  </Page>;
}
export { ParticipantCategoryPanel } from "./ParticipantCategoryPanel";
