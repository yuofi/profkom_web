import { UserChip } from "../../components/Workspace/UserChip";
import { BlockAvatarPicker } from "../../components/Workspace/BlockAvatarPicker";
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router-dom";
import { getBlockRoute } from "../../utils/routes";
import {
  Page,
  Card,
  QueryState,
  RouteLink,
  Badge,
  Empty,
  Glyph,
} from "../../components/Workspace/WorkspaceUI";
import { Markdown } from "../../components/Workspace/WorkspaceMarkdown";
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
import { RegistrationDecision } from "../../components/Workspace/RegistrationDecision";
import { can, useSession } from "../../utils/session";
import { displayDate, waited } from "../../utils/dates";
import { useDeadlineRefresh } from "../../utils/hooks/useDeadlineRefresh";
import {
  usePeopleOptions,
  useWorkspaceActions,
} from "../../utils/hooks/useWorkspace";
import { DeputiesForm, Leaders } from "./EventLeaders";
import { OrganizationTree } from "./OrganizationTree";
import { BlockHr } from "./BlockHr";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { TaskChatSettingsAction } from "./TaskChatSettings";
import { BlockSettingsAction, BlockDeletionStatus, CreateBlockAction } from "./BlockSettings";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { userMessage } from "../../utils/api/messages";
import { botLinkLabels } from "../../components/Workspace/botLink";
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
const openStates: BlockRequest["state"][] = ["pending_hr", "pending_block"];
const closedStates: BlockRequest["state"][] = ["approved", "rejected", "withdrawn"];
const historyPage = 20;
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
        <div className={s.row}>{can(session, "create_block") && <CreateBlockAction />}<RouteLink to="/blocks/requests">{can(session, "view_block_requests") ? "Заявки в блоки" : "Мои заявки и решения"}</RouteLink></div>
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
  const { perform, refresh } = useWorkspaceActions();
  const [leadership, setLeadership] = useState(false);
  const query = useQuery({
    queryKey: ["workspaceBlocks", id],
    queryFn: () => membershipApi.block(id, { include_deputies: true }),
  });
  const b = !query.error || canRetainData(query.error) ? query.data : undefined;
  // The directory serves only the master assignment form (PF-13).
  const people = usePeopleOptions({ enabled: can(b, "manage_leaders") });
  const canViewTracker = can(b, "view_tasks");
  const alreadyInBlock = !!b && !!session && (b.members.some(member => member.user.user_id === session.user_id) || b.master?.user.user_id === session.user_id || !!b.master?.deputy_user_ids.includes(session.user_id));
  // A member cannot leave on their own (403 self_leave_forbidden): say whom to ask (PE-22).
  const plainMember = !!b && !!session && b.members.some(member => member.user.user_id === session.user_id) && b.master?.user.user_id !== session.user_id && !b.master?.deputy_user_ids.includes(session.user_id);
  // Deputies come as references with include_deputies; the directory is not read for them (PF-13).
  const deputies = b?.master ? (b.master.deputies?.length === b.master.deputy_user_ids.length ? b.master.deputies : b.master.deputy_user_ids.map(userId => people.options.find(option => option.value === String(userId))?.user)) : [];
  const leaveContacts = b ? [b.master?.user, ...deputies, b.hr]
    .filter((user, index, all): user is NonNullable<typeof user> => !!user?.user_id && user.user_id !== session?.user_id && all.findIndex(other => other?.user_id === user.user_id) === index) : [];
  // Only the own requests to this block, not the whole visible history (PB-22, PF-13).
  const requests = useQuery({
    queryKey: ["blockRequests", "mine", id],
    queryFn: () => membershipApi.requests({ block_id: id, mine: true }),
  });
  const pending = requests.data?.items.find(
    (r) =>
      r.block_id === id &&
      r.user.user_id === session?.user_id &&
      ["pending_hr", "pending_block"].includes(r.state),
  );
  // An old address by name (/blocks/Медиа) moves to the block's id, so every link and request below uses the id.
  if (b && id !== b.block_id) return <Navigate replace to={getBlockRoute(b.block_id)} />;
  const member = !!b && b.members.some(item => item.user.user_id === session?.user_id);
  const described = !!b?.description.body.trim();
  // The block's own actions stand in one row under its name, as on a subevent page (D-05).
  const nav = b && (
    <div className={`${s.row} ${m.blockNav}`} role="group" aria-label="Действия блока">
      {!b.archived_at && (can(b, "rename_block") || can(b, "edit_block") || can(b, "start_block_deletion")) && <BlockSettingsAction block={b} />}
      {can(b, "manage_chat") && <TaskChatSettingsAction scope={{ kind: "block", id: b.block_id }} />}
      {canViewTracker && (
        <RouteLink
          to={`/tasks?scope_kind=block&scope_id=${encodeURIComponent(id)}`}
        >
          Задачи блока
        </RouteLink>
      )}
      {can(b, "create_volunteer_merit") && <RouteLink to={`/merits?source_kind=block_volunteer&scope_id=${encodeURIComponent(id)}`}>Учесть волонтёрскую работу</RouteLink>}
      {b.guide_material_id && can(b, "read_guide") ? (
        <RouteLink
          to={`/materials/${encodeURIComponent(b.guide_material_id)}`}
        >
          Гайд блока
        </RouteLink>
      ) : b.guide_material_id ? (
        <span className={`${s.muted} ${m.navNote}`}>Гайд доступен участникам блока</span>
      ) : (
        <span className={`${s.muted} ${m.navNote}`}>Гайд ещё готовится</span>
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
      {alreadyInBlock ? null : pending ? (
        <p>
          Заявка: {requestStates[pending.state]} ·{" "}
          <RouteLink to="/blocks/requests">Открыть</RouteLink>
        </p>
      ) : session?.service_account ? (
        // The server refuses it any application (403, owner 2026-11-08): say so instead of the button.
        <span className={`${s.muted} ${m.navNote}`}>Сервисный аккаунт не состоит в блоках</span>
      ) : (
        !member && (
          <ActionForm
            fields={[]}
            submitLabel="Подать заявку в блок"
            onSubmit={async () => {
              await perform(() => membershipApi.join(id));
            }}
          />
        )
      )}
    </div>
  );
  return (
    <Page
      title={b?.name ?? "Блок"}
      headerNav={nav}
      actions={<div className={`${s.row} ${m.blockHeaderActions}`}>{b && <BlockAvatarPicker block={b} />}<RouteLink to="/blocks">Все блоки</RouteLink></div>}
    >
      <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
        {b && (
          <div className={s.stack}>
            <BlockDeletionStatus block={b} />
            {/* The description, with its form a click away; a block without one and without the
                right to write it has no card at all (D-05). */}
            {(described || can(b, "edit_block")) && (
              <Card title="О блоке" className={m.about}>
                {described && <Markdown content={b.description} />}
                {can(b, "edit_block") && (
                  // A closed disclosure keeps the form and its draft; leaving the page still asks about it.
                  <details className={s.details}>
                    <summary>Изменить описание</summary>
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
                  </details>
                )}
              </Card>
            )}
            {/* The master with the deputies and the block's HR read together (D-05). */}
            <Card>
              <div className={s.between}>
                <h2>Руководство</h2>
                {(can(b, "manage_leaders") || can(b.master, "manage_deputies")) && (
                  <button type="button" className={s.button} onClick={() => setLeadership(true)}><Glyph name="edit" />Изменить руководство</button>
                )}
              </div>
              <div className={m.leadership}>
                <div className={m.leadershipPart}>
                  <h3>Мастер блока</h3>
                  <Leaders leaders={b.master ? [b.master] : []} editable={false} />
                </div>
                <div className={`${m.leadershipPart} ${m.hrPart}`}>
                  <h3>HR блока</h3>
                  <BlockHr block={b} />
                </div>
              </div>
              <p className={`${s.muted} ${m.note}`}>
                Служебное назначение мастера или заместителя отдельно от
                обычного членства.
              </p>
              {leadership && <UnsavedChangesScope><TrackerTaskDialog title="Руководство блока" onClose={() => setLeadership(false)}>
              {/* Two server commands with their own rights and revisions: each section saves on its own. */}
              {can(b, "manage_leaders") && (<section className={s.stack} aria-label="Мастер блока"><h3>Мастер блока</h3>
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
              </section>)}
              {b.master && can(b.master, "manage_deputies") && <section className={s.stack} aria-label="Заместители мастера"><h3>Заместители мастера</h3><DeputiesForm leader={b.master} /></section>}
              </TrackerTaskDialog></UnsavedChangesScope>}
            </Card>
            <Card title="Состав блока" className={m.members}>
              <ul className={s.list}>
                {b.members.map((item) => (
                  <li key={item.user.user_id}>
                    <div className={`${s.between} ${m.member}`}>
                      <span className={`${s.row} ${m.memberName}`}>
                        <UserChip user={item.user} />
                        <Badge tone={item.block_category === "junior" ? "mint" : undefined}>
                          {item.block_category === "junior"
                            ? "Новичок блока"
                            : "Участник"}
                        </Badge>
                      </span>
                      {can(b, "remove_member") &&
                        item.user.user_id !== session?.user_id && item.user.user_id !== b.master?.user.user_id && !b.master?.deputy_user_ids.includes(item.user.user_id!) && (
                          <ActionForm
                            fields={[]}
                            // A short word in the row; its full name says whom it removes (D-05).
                            submitLabel="Убрать"
                            submitTitle={`Убрать из состава: ${item.user.display_name}`}
                            variant="danger"
                            confirm={{
                              label: "Да, исключить",
                              text: `Исключить ${item.user.display_name} из блока «${b.name}»? Вернуться в блок участник сможет только по новой заявке.`,
                            }}
                            onSubmit={async () => {
                              await perform(() =>
                                membershipApi.remove(id, item.user.user_id!),
                              );
                            }}
                          />
                        )}
                    </div>
                  </li>
                ))}
              </ul>
              {plainMember && (
                <div className={s.row}>
                  <span className={s.muted}>
                    Чтобы выйти из блока, обратитесь к мастеру, его заместителю или HR блока{leaveContacts.length ? ":" : "."}
                  </span>
                  {leaveContacts.map(user => <UserChip key={user.user_id} user={user} />)}
                </div>
              )}
            </Card>
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
  const [rejecting, setRejecting] = useState(false);
  const open = ["pending_hr", "pending_block"].includes(r.state);
  const review = can(
    r,
    r.state === "pending_hr" ? "hr_review_request" : "block_review_request",
  );
  const wait = waited(r.stage_entered_at);
  return (
    <Card>
      <h2 className={m.requestTitle}><UserChip user={r.user} /><span>→ {blockName}</span></h2>
      <div className={s.row}><Badge tone={requestTones[r.state]}>{requestStates[r.state]}</Badge>{open && <RouteLink to={`/blocks/${encodeURIComponent(r.block_id)}`}>Открыть блок</RouteLink>}</div>
      {open ? (
        <p>
          Текущий этап с {displayDate(r.stage_entered_at)} ·{" "}
          <span className={s.nowrap}>ждёт {wait === "0 ч" ? "меньше часа" : wait}</span>
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
          Если решение не принято до {displayDate(r.substitute_available_at)}, его смогут принять председатель или его заместители.
        </p>
      )}
      {/* Approving and rejecting side by side; the reason is asked in a dialog (PE-27). */}
      {open && review && (
        <div className={m.requestDecisions}>
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
          <button type="button" className={`${s.button} ${m.reject}`} onClick={() => setRejecting(true)}>
            Отклонить
          </button>
        </div>
      )}
      {rejecting && open && review && (
        <UnsavedChangesScope><TrackerTaskDialog title="Отклонить заявку в блок" onClose={() => setRejecting(false)}>
          <p>{r.user.display_name} → {blockName}</p>
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
            submitLabel="Отклонить заявку"
            variant="danger"
            onSubmit={async (v, expectedRevision) => {
              const saved = await perform(() =>
                membershipApi.requestCommand(r.request_id, "reject", {
                  expected_revision: expectedRevision!,
                  reason: text(v, "reason"),
                }),
              );
              setRejecting(false);
              return saved;
            }}
          />
        </TrackerTaskDialog></UnsavedChangesScope>
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
  // Open requests in full (they are decided here), the own closed ones, and the rest of the
  // history in keyset pages of 20 from the newest (PB-22) instead of every request with a full DTO.
  const query = useQuery({
    queryKey: ["blockRequests", "open"],
    queryFn: () => membershipApi.requests({ state: openStates }),
    refetchOnWindowFocus: "always",
    refetchInterval: (query) =>
      query.state.data?.items.some((r) =>
        ["pending_hr", "pending_block"].includes(r.state),
      )
        ? 60_000
        : false,
  });
  const mine = useQuery({
    queryKey: ["blockRequests", "mine", "closed"],
    queryFn: () => membershipApi.requests({ mine: true, state: closedStates }),
    refetchOnWindowFocus: "always",
  });
  const history = useInfiniteQuery({
    queryKey: ["blockRequests", "history"],
    queryFn: ({ pageParam }) => membershipApi.requests({ state: closedStates, limit: historyPage, order: "desc", ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  useDeadlineRefresh(
    query.data?.items
      .filter((r) => ["pending_hr", "pending_block"].includes(r.state))
      .flatMap((r) =>
        r.substitute_available_at ? [r.substitute_available_at] : [],
      ) ?? [],
    query.refetch,
  );
  // A request decided elsewhere leaves the open list: reread the closed lists to show it there.
  const client = useQueryClient(), openIds = query.data?.items.map(r => r.request_id).join(" "), previousOpen = useRef<string | undefined>(undefined);
  useEffect(() => {
    const before = previousOpen.current;previousOpen.current = openIds;
    if (before === undefined || openIds === undefined) return;
    const now = new Set(openIds.split(" "));
    if (before.split(" ").some(id => id && !now.has(id)))
      void client.invalidateQueries({ queryKey: ["blockRequests"], predicate: item => item.queryKey[1] !== "open" });
  }, [client, openIds]);
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
  // The open list is the freshest copy of an open request; the list keeps the server order.
  const byId = new Map<string, BlockRequest>();
  for (const r of [...history.data?.pages.flatMap(page => page.items) ?? [], ...mine.data?.items ?? [], ...query.data?.items ?? []]) byId.set(r.request_id, r);
  const loaded = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.request_id.localeCompare(b.request_id));
  const errors = [query.error, mine.error, history.error].filter(Boolean), error = errors.find(item => !canRetainData(item)) ?? errors[0] ?? null;
  for (const r of loaded) {
    const index = can(r, "hr_review_request") ? 0 : can(r, "block_review_request") ? 1
      : r.user.user_id === session?.user_id ? 2 : isOpen(r) ? 3 : 4;
    sections[index][1].push(r);
  }
  // The history is paged from its latest end: newest first, "Показать ещё" adds older ones.
  sections[4][1].reverse();
  // «Показать ещё» keeps the keyboard focus while its page loads: aria-disabled, as `disabled`
  // on the focused button drops the focus to <body>. The last page removes the button, so its
  // focus moves to the first older request that page added.
  const shownHistory = sections[4][1].length, loadingMore = history.isFetchingNextPage;
  const historyList = useRef<HTMLUListElement>(null), more = useRef<HTMLButtonElement>(null), firstAdded = useRef<number | null>(null);
  useEffect(() => {
    const index = firstAdded.current;
    if (index === null || loadingMore) return;
    firstAdded.current = null;
    if (shownHistory > index && !more.current && (!document.activeElement || document.activeElement === document.body)) historyList.current?.children[index]?.querySelector<HTMLElement>("summary")?.focus();
  }, [shownHistory, loadingMore]);
  const blockName = (r: BlockRequest) => blocks.data?.find((b) => b.block_id === r.block_id)?.name ?? "Блок";
  const card = (r: BlockRequest) => (
    <RequestCard
      request={r}
      key={r.request_id}
      blockName={blockName(r)}
    />
  );
  return (
    <Page
      title="Заявки в блоки"
      description="Обычный блок: HR, затем мастер. В HR-блок вступление завершается после одного решения HR."

    >
      <QueryState keepDataOnError={!!query.data && !!mine.data && !!history.data}
        loading={query.isLoading || mine.isLoading || history.isLoading} error={error} retry={() => { void query.refetch();void mine.refetch();void history.refetch(); }}>
        <div className={s.stack}>
          {sections.map(([title, items]) =>
            items.length === 0 && !(title === "История" && history.hasNextPage) ? null : title === "История" ? (
              // History is a compact list of rows, twenty a page; a row opens its card (PE-27).
              <details key={title} className={s.details}>
                <summary>История · {items.length}</summary>
                <ul ref={historyList} className={m.history}>
                  {items.map((r) => (
                    <li key={r.request_id}>
                      <details className={m.historyRow}>
                        <summary>
                          <span>{r.user.display_name} → {blockName(r)}</span>
                          <Badge tone={requestTones[r.state]}>{requestStates[r.state]}</Badge>
                          {r.decided_at && <small>{displayDate(r.decided_at)}</small>}
                        </summary>
                        {card(r)}
                      </details>
                    </li>
                  ))}
                </ul>
                {history.hasNextPage && (
                  <button ref={more} type="button" className={s.button} aria-disabled={loadingMore || undefined} aria-busy={loadingMore || undefined} onClick={() => { if (loadingMore) return;firstAdded.current = shownHistory;void history.fetchNextPage(); }}>
                    Показать ещё
                  </button>
                )}
              </details>
            ) : (
              <section key={title} aria-label={title} className={s.stack}>
                <h2>{title}</h2>
                {items.map(card)}
              </section>
            ),
          )}
          {!!query.data && !!mine.data && !!history.data && !loaded.length && !history.hasNextPage && <Empty>Заявок пока нет.</Empty>}
        </div>
      </QueryState>
    </Page>
  );
}
const BOT_NOT_READY = "Одобрить можно, когда заявитель привяжет и настроит бота ВКонтакте.";
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
    catch (failure) { setError(userMessage(failure, { bot_link_required: BOT_NOT_READY }));await refresh(); }
    finally { setBusy(false); }
  };
  // Stage 2: an application is ready only with a working VK link; the server refuses others (409).
  const botBlocks = !!r.bot_link && r.bot_link.state !== "ok";
  const reasonId = `registration-${r.user_id}-bot`;
  return <Card className={m.registrationCard}>
    <details className={m.registrationDetails} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary><div><strong>{r.fields.surname} {r.fields.name} {r.fields.patronymic}</strong><small>{[r.fields.group_number, r.fields.email].filter(Boolean).join(" · ")}</small></div><span className={s.badges}><Badge tone={r.status === "pending" ? "peach" : r.status === "rejected" ? "rose" : "mint"}>{r.status === "pending" ? "Ожидает решения" : r.status === "rejected" ? "Отклонена" : "Одобрена"}</Badge>{r.bot_link && <Badge tone={r.bot_link.state === "ok" ? "mint" : "rose"}>Бот: {botLinkLabels[r.bot_link.state]}</Badge>}</span></summary>
      {expanded && <div className={m.registrationBody}>
        <dl className={m.registrationFields}>{Object.entries(registrationLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{r.fields[key as keyof typeof registrationLabels] || "—"}</dd></div>)}<div><dt>Основа обучения</dt><dd>{r.fields.funding ? fundingLabels[r.fields.funding] : "Не выбрано"}</dd></div></dl>
        <p className={s.muted}>Отправок: {r.attempts_used}/{r.attempt_limit} · за всё время: {r.total_submissions}</p>
        {r.rejection_reason && <p>Причина отказа: {r.rejection_reason}</p>}
        {r.status !== "approved" && can(r, "reset_registration_limit") && <details className={s.details}><summary>Сбросить лимит отправок</summary><ActionForm revision={r.revision} record={`registration:${r.user_id}`} fields={[{ name: "reason", label: "Основание сброса счётчика", required: true }]} submitLabel="Сбросить лимит" variant="quiet" onConflict={refresh} onSubmit={async (values, revision) => perform(() => membershipApi.registrationCommand(r.user_id, "reset-attempts", { expected_revision: revision!, reason: text(values, "reason") }))} /></details>}
      </div>}
    </details>
    <RegistrationDecision application={r} />
    {r.status === "pending" && botBlocks && <p id={reasonId} className={`${s.muted} ${m.decisionNote}`}>{BOT_NOT_READY}</p>}
    {r.status === "pending" && <div className={m.decisions}><button type="button" className={s.button} aria-busy={busy} disabled={busy || botBlocks} aria-describedby={botBlocks ? reasonId : undefined} onClick={() => void approve()}>Одобрить</button><button type="button" className={`${s.button} ${m.reject}`} disabled={busy} onClick={() => setRejecting(true)}>Отклонить</button></div>}
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
