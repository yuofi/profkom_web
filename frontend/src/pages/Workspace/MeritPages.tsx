import { useState, type ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Page,
  Card,
  QueryState,
  ErrorState,
  Markdown,
  Empty,
  RouteLink,
} from "../../components/Workspace/WorkspaceUI";
import { ActionForm, type Field } from "../../components/Workspace/ActionForm";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { revisionSnapshot, snapshotRevisions } from "../../components/Workspace/revisionSnapshot";
import { text, number, ids } from "../../components/Workspace/formValues";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { eventsApi } from "../../utils/api/events.api";
import { membershipApi } from "../../utils/api/membership.api";
import {
  emptyCriteria,
  richText,
  type Merit,
  type Session,
  type Season,
  type MeritCreate,
  type MeritPatch,
  type TaskInputs,
  type AssessmentInputs,
} from "../../utils/api/contract";
import { canRetainData } from "../../utils/api/request";
import { can, useSession } from "../../utils/session";
import { toUtc, displayDate, moscowInput } from "../../utils/dates";
import {
  usePeopleOptions,
  useWorkspaceActions,
} from "../../utils/hooks/useWorkspace";
import s from "../../components/Workspace/Workspace.module.css";
const kinds: Record<MeritCreate["source_kind"], string> = {
  head_merit: "Особая заслуга на мероприятии",
  chair_merit: "Заслуга председателя",
  block_volunteer: "Волонтёрская работа блока",
  subevent_volunteer: "Волонтёрская работа подмероприятия",
};
const criteriaLabels = {
  unique: "Уникальная работа",
  creative: "Творческая",
  external_communication: "Общение вне вуза",
  in_person: "Очное присутствие",
  fixed_time: "В определённое время",
};
/** PATCH /merits/{id} takes only these fields; kind, season and scope stay as created (A-KKR-1). */
function meritPatch({ title, description, assigned_at, deadline_at, criteria, recipients }: MeritCreate): MeritPatch {
  return { title, description, assigned_at, deadline_at, criteria, recipients };
}
function useMeritContexts(enabled: boolean) {
  return useQuery({
    queryKey: ["merits", "contexts"],
    enabled,
    queryFn: async () => {
      const [blocks, events] = await Promise.all([
        membershipApi.blocks(),
        eventsApi.list(),
      ]);
      const subs = (
        await Promise.all(
          events.items.map((e) => eventsApi.subevents(e.event_id)),
        )
      ).flatMap((x) => x.items);
      return { blocks, events: events.items, subs };
    },
  });
}
function allowedMeritKinds(session: Session | null, contexts: ReturnType<typeof useMeritContexts>["data"], season?: Season) {
  if (!season || season.state === "closed") return [];
  const eventIds = new Set(contexts?.events.filter((e) => e.season_id === season.season_id).map((e) => e.event_id));
  return Object.entries(kinds).filter(([kind]) => {
    if (kind === "chair_merit") return can(session, "create_chair_merit") && season.state !== "planned";
    if (kind === "head_merit") return contexts?.events.some((e) => eventIds.has(e.event_id) && can(e, "create_head_merit"));
    if (kind === "subevent_volunteer") return contexts?.subs.some((sub) => eventIds.has(sub.event_id) && can(sub, "create_volunteer_merit"));
    return season.state !== "planned" && contexts?.blocks.some((b) => can(b, "create_volunteer_merit"));
  });
}

/** Blocks have no fixed season; pick an eligible one before opening its form. */
export function MeritEntryPage() {
  const { session } = useSession();
  const [params] = useSearchParams();
  const contexts = useMeritContexts(true);
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const requested = params.get("source_kind");
  const scopeId = params.get("scope_id");
  const eligible = seasons.data?.items.filter((season) => allowedMeritKinds(session, contexts.data, season).some(([kind]) => {
    if (requested && requested !== kind) return false;
    if (!scopeId) return true;
    return kind === "block_volunteer" ? contexts.data?.blocks.some((b) => b.block_id === scopeId && can(b, "create_volunteer_merit"))
      : kind === "head_merit" ? contexts.data?.events.some((e) => e.event_id === scopeId && e.season_id === season.season_id && can(e, "create_head_merit"))
      : kind === "subevent_volunteer" && contexts.data?.subs.some((sub) => sub.subevent_id === scopeId && contexts.data?.events.some((e) => e.event_id === sub.event_id && e.season_id === season.season_id) && can(sub, "create_volunteer_merit"));
  })) ?? [];
  return <Page title="Учёт выполненной работы" description="Выберите сезон. Доступны только исходные поля разрешённых вам записей.">
    <QueryState loading={contexts.isLoading || seasons.isLoading} error={contexts.error || seasons.error}>
      <div className={s.grid}>{eligible.map((season) => <Card key={season.season_id} title={season.title}>
        <RouteLink to={`/seasons/${encodeURIComponent(season.season_id)}/merits?${params.toString()}`}>Особые заслуги и волонтёры</RouteLink>
      </Card>)}</div>
      {!eligible.length && <Empty>Нет доступных сезонов и областей для записи выполненной работы.</Empty>}
    </QueryState>
  </Page>;
}

function MeritEditor({
  seasonId,
  existing,
  save,
  initialSource,
  initialScopeId,
  summaryVersion,
  onCreated,
}: {
  seasonId: string;
  existing?: Merit;
  onCreated?: (merit: Merit) => void;
  save?: (data: MeritCreate, revision: number, summaryVersion: number) => Promise<{revision: number; revisionKey: string}>;
  summaryVersion?: number;
  initialSource?: MeritCreate["source_kind"];
  initialScopeId?: string;
}) {
  const { session } = useSession();
  const requestContextChange = useGuardedAction();
  const { perform, refresh } = useWorkspaceActions();
  const people = usePeopleOptions();
  // An existing record needs the lists only for its scope name, so they never block its form.
  const contexts = useMeritContexts(true);
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list, enabled: !existing });
  const season = seasons.data?.items.find((x) => x.season_id === seasonId);
  const allowedKinds = allowedMeritKinds(session, contexts.data, season);
  const [selectedPeople, setSelectedPeople] = useState<{ value: string; label: string }[]>(() =>
    (existing?.recipients ?? []).map((r) => {
      const person = people.data?.find((p) => p.user_id === r.user_id);
      return { value: String(r.user_id), label: person ? `${person.surname} ${person.name}` : `Участник #${r.user_id} · сохранённый получатель` };
    }),
  );
  const recipientOptions = [...people.options,
    ...selectedPeople.filter((p) => !people.options.some((current) => current.value === p.value)).map((p) => ({ ...p, label: `${p.label} · нет в актуальном справочнике` })),
  ];
  for (const recipient of existing?.recipients ?? []) {
    if (!recipientOptions.some((p) => p.value === String(recipient.user_id))) {
      const person = people.data?.find((p) => p.user_id === recipient.user_id);
      recipientOptions.push({
        value: String(recipient.user_id),
        label: person
          ? `${person.surname} ${person.name}`
          : `Участник #${recipient.user_id} · сохранённый получатель`,
      });
    }
  }
  const [sourceChoice, setSource] = useState<MeritCreate["source_kind"]>(
    existing?.source_kind ?? initialSource ?? "block_volunteer",
  );
  const source = existing?.source_kind ?? (allowedKinds.some(([k]) => k === sourceChoice) ? sourceChoice : allowedKinds[0]?.[0] as MeritCreate["source_kind"] ?? sourceChoice);
  const [scopeId, setScopeId] = useState(
    existing?.scope?.id ?? existing?.event_id ?? initialScopeId ?? "",
  );
  const scopeOptions =
    source === "block_volunteer"
      ? contexts.data?.blocks
          .filter((x) => can(x, "create_volunteer_merit"))
          .map((x) => ({ value: x.block_id, label: x.name }))
      : source === "subevent_volunteer"
        ? contexts.data?.subs
            .filter((x) => contexts.data?.events.some((e) => e.event_id === x.event_id && e.season_id === seasonId) && can(x, "create_volunteer_merit"))
            .map((x) => ({ value: x.subevent_id, label: x.title }))
        : contexts.data?.events
            .filter((x) => x.season_id === seasonId && can(x, "create_head_merit"))
            .map((x) => ({ value: x.event_id, label: x.title }));
  const savedScope = !existing ? undefined
    : existing.source_kind === "block_volunteer" ? contexts.data?.blocks.find((x) => x.block_id === scopeId)?.name
    : existing.source_kind === "subevent_volunteer" ? contexts.data?.subs.find((x) => x.subevent_id === scopeId)?.title
    : contexts.data?.events.find((x) => x.event_id === scopeId)?.title;
  const fields: Field[] = [
    {
      name: "title",
      label: "Название",
      value: existing?.title ?? "",
      required: true,
    },
    {
      name: "body",
      label: "Описание",
      type: "textarea",
      required: true,
      value: existing?.description.body ?? "",
    },
    {
      name: "assigned",
      label: "Дата выдачи, МСК",
      type: "datetime-local",
      required: true,
      value: existing ? moscowInput(existing.assigned_at) : "",
    },
    {
      name: "deadline",
      label: "Дедлайн, МСК",
      type: "datetime-local",
      required: true,
      value: existing ? moscowInput(existing.deadline_at) : "",
    },
    ...Object.entries(criteriaLabels).map(([name, label]) => ({
      name,
      label,
      type: "select" as const,
      value: String(
        existing?.criteria[name as keyof typeof criteriaLabels] ?? false,
      ),
      options: [
        { value: "false", label: "Нет" },
        { value: "true", label: "Да" },
      ],
    })),
    {
      name: "users",
      label: source.endsWith("_volunteer") ? "Волонтёры вне состава области" : "Получатели",
      type: "multi",
      required: true,
      value: existing?.recipients.map((r) => String(r.user_id)),
      options: recipientOptions,
      onSelectionChange: (values) => setSelectedPeople(values.map((value) =>
        people.options.find((p) => p.value === value) ?? selectedPeople.find((p) => p.value === value) ?? { value, label: `Участник #${value}` },
      )),
    },
    ...recipientOptions.flatMap((p) => [
      {
        name: `hours_${p.value}`,
        whenSelected: { name: "users", value: p.value },
        required: true,
        label: `Часы: ${p.label}`,
        type: "number" as const,
        min: 0,
        value: String(
          existing?.recipients.find((r) => r.user_id === Number(p.value))
            ?.hours ?? "",
        ),
      },
      {
        name: `evaluation_${p.value}`,
        whenSelected: { name: "users", value: p.value },
        required: true,
        label: `Оценка: ${p.label}`,
        type: "select" as const,
        value: String(
          existing?.recipients.find((r) => r.user_id === Number(p.value))
            ?.evaluation ?? "",
        ),
        options: [-1, 0, 1, 1.5].map((n) => ({
          value: String(n),
          label: String(n),
        })),
      },
      {
        name: `completed_${p.value}`,
        whenSelected: { name: "users", value: p.value },
        label: `Дата выполнения, МСК: ${p.label}`,
        type: "datetime-local" as const,
        value: existing?.recipients.find((r) => r.user_id === Number(p.value))
          ?.completed_at
          ? moscowInput(
              existing.recipients.find((r) => r.user_id === Number(p.value))!
                .completed_at!,
            )
          : "",
      },
    ]),
    {
      name: "reason",
      label: "Основание записи / причина исправления",
      required: true,
      type: "textarea",
    },
  ];
  return (
    <QueryState
      keepDataOnError={!!people.data && (!!existing || (!!contexts.data && !!seasons.data))}
      loading={(!existing && (contexts.isLoading || seasons.isLoading)) || people.isLoading}
      error={(!existing && (contexts.error || seasons.error)) || people.error}
    >
      <div className={s.form}>
        {existing && (
          <details>
            <summary>Текущие сохранённые значения заслуги</summary>
            <p>
              {existing.title}: {displayDate(existing.assigned_at)} —{" "}
              {displayDate(existing.deadline_at)}
            </p>
            <ul>
              {existing.recipients.map((r) => (
                <li key={r.user_id}>
                  {
                    recipientOptions.find((p) => p.value === String(r.user_id))
                      ?.label
                  }
                  : часы {r.hours}, оценка {r.evaluation}, выполнено{" "}
                  {displayDate(r.completed_at)}
                </li>
              ))}
            </ul>
          </details>
        )}
        <label className={s.field}>
          Вид записи
          <select
            disabled={!!existing}
            value={source}
            onChange={(e) => {
              const next = e.target.value as typeof source;
              requestContextChange(() => {
                setSource(next);
                setScopeId("");
                setSelectedPeople([]);
              });
            }}
          >
            <option value="">Выберите…</option>
            {(existing
              ? [[existing.source_kind, kinds[existing.source_kind]]]
              : allowedKinds
            ).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {source !== "chair_merit" && (
          <label className={s.field}>
            Область работы
            <select
              disabled={!!existing}
              value={scopeId}
              onChange={(e) => {
                const next = e.target.value;
                requestContextChange(() => { setScopeId(next); setSelectedPeople([]); });
              }}
            >
              <option value="">Выберите…</option>
              {(existing
                ? [{ value: scopeId, label: savedScope ?? (contexts.isLoading ? "Загрузка названия…" : "Сохранённая область") }]
                : scopeOptions
              )?.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className={s.muted}>
          {source.endsWith("_volunteer") ? (
            <>
              Волонтёрская работа — помощь активиста, который не входил в состав
              выбранного {source === "block_volunteer" ? "блока" : "подмероприятия"} на дату выполнения.
              Запись относится только к этой области и не даёт участнику доступ к её задачам.
              Укажите часы и оценку выбранным волонтёрам. Состав на дату работы проверяется при сохранении.
            </>
          ) : (
            <>Укажите часы и оценку только выбранным получателям этой заслуги.</>
          )}
        </p>
        {!people.isLoading && (
          <ActionForm
            key={`${source}/${scopeId}/${existing?.merit_id ?? "new"}`}
            revision={existing?.revision}
            revisionKey={summaryVersion === undefined ? undefined : String(summaryVersion)}
            fields={fields}
            onConflict={async () => {
              await people.refetch();
              await refresh();
            }}
            onSubmit={async (v, expectedRevision, expectedVersion) => {
              if (
                (!existing && !allowedKinds.some(([k]) => k === source)) ||
                (source !== "chair_merit" && (!scopeId || (!existing && !scopeOptions?.some((option) => option.value === scopeId))))
              )
                throw Error("Выберите доступную область работы");
              const eventId =
                source === "head_merit"
                  ? scopeId
                  : source === "subevent_volunteer"
                    ? contexts.data?.subs.find((x) => x.subevent_id === scopeId)
                        ?.event_id
                    : undefined;
              const fixedSeason = contexts.data?.events.find(
                (x) => x.event_id === eventId,
              )?.season_id;
              if (!existing && fixedSeason && fixedSeason !== seasonId)
                throw Error("Откройте форму из сезона выбранного мероприятия");
              const assigned = toUtc(text(v, "assigned")),
                deadline = toUtc(text(v, "deadline"));
              if (assigned > deadline)
                throw Error("Дата выдачи позже дедлайна");
              const recipients = ids(v, "users").map((user_id) => {
                const evaluation = text(v, `evaluation_${user_id}`),
                  hours = text(v, `hours_${user_id}`),
                  completed = text(v, `completed_${user_id}`);
                if (
                  !hours ||
                  !evaluation ||
                  (Number(evaluation) > 0 && !completed)
                )
                  throw Error(
                    "Заполните часы, оценку и дату положительного результата каждого получателя",
                  );
                return {
                  user_id,
                  hours: Number(hours),
                  evaluation: Number(evaluation) as -1 | 0 | 1 | 1.5,
                  completed_at: completed ? toUtc(completed) : null,
                };
              });
              const data: MeritCreate = {
                season_id: fixedSeason ?? seasonId,
                source_kind: source,
                ...(source === "head_merit"
                  ? { event_id: scopeId }
                  : source === "chair_merit"
                    ? {}
                    : {
                        scope: {
                          kind:
                            source === "block_volunteer" ? "block" : "subevent",
                          id: scopeId,
                        },
                      }),
                title: text(v, "title"),
                description: richText(text(v, "body")),
                assigned_at: assigned,
                deadline_at: deadline,
                criteria: {
                  ...emptyCriteria(),
                  ...Object.fromEntries(
                    Object.keys(criteriaLabels).map((k) => [
                      k,
                      text(v, k) === "true",
                    ]),
                  ),
                },
                recipients,
                reason: text(v, "reason"),
              };
              if (save) {
                return save(data, expectedRevision!, Number(expectedVersion));
              }
              if (existing)
                return perform(() =>
                  seasonsApi.updateMerit(existing.merit_id, {
                    ...meritPatch(data),
                    reason: data.reason,
                    expected_revision: expectedRevision!,
                  }),
                );
              // A new empty form replaces this one, so a second click cannot repeat the record (A-KKR-24).
              const merit = await perform(() => seasonsApi.createMerit(data));
              onCreated?.(merit);
            }}
            submitLabel={
              existing ? "Сохранить исправление" : "Записать выполненную работу"
            }
          />
        )}
      </div>
    </QueryState>
  );
}
export function MeritForm(props: ComponentProps<typeof MeritEditor>) {
  return <UnsavedChangesScope><MeritEditor {...props} /></UnsavedChangesScope>;
}

export function MeritsPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const [params] = useSearchParams();
  const contexts = useMeritContexts(true);
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const [created, setCreated] = useState<{ count: number; title?: string }>({ count: 0 });
  const season = seasons.data?.items.find((x) => x.season_id === id);
  const allowedKinds = allowedMeritKinds(session, contexts.data, season);
  const readable = allowedKinds.length > 0 || can(session, "view_summary");
  const query = useQuery({
    queryKey: ["merits", id],
    queryFn: () => seasonsApi.merits({ season_id: id }),
    enabled: readable,
  });
  if (contexts.isLoading || seasons.isLoading) return <QueryState loading error={null}>{null}</QueryState>;
  if ((contexts.error && (!contexts.data || !canRetainData(contexts.error))) || (seasons.error && (!seasons.data || !canRetainData(seasons.error)))) return <QueryState loading={false} error={contexts.error || seasons.error}>{null}</QueryState>;
  if (!readable) return <Page title="Особые заслуги"><Empty>Нет доступа к исходным полям.</Empty></Page>;
  return (
    <Page
      title="Особые заслуги и волонтёры"
      actions={
        <RouteLink to={`/seasons/${encodeURIComponent(id)}`}>Сезон</RouteLink>
      }
    >
      <div className={s.stack}>
        {(contexts.error || seasons.error) && <ErrorState error={contexts.error || seasons.error} />}
        <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data}>
          {query.data?.items.map((m) => (
            <Card key={m.merit_id} title={m.title}>
              <p>
                {kinds[m.source_kind]} · {displayDate(m.assigned_at)}
              </p>
              <Markdown content={m.description} />
              {can(m, "edit_assessment_inputs") && (
                <details className={s.details}>
                  <summary>Исправить исходные поля</summary>
                  <MeritForm seasonId={id} existing={m} />
                </details>
              )}
            </Card>
          ))}
        </QueryState>
        {allowedKinds.length > 0 && (
          <Card title="Учесть выполненную работу">
            {created.title && <p role="status" className={s.success}>Работа записана: {created.title}</p>}
            <MeritForm key={`${id}/${params.get("source_kind")}/${params.get("scope_id")}/${created.count}`} seasonId={id}
              onCreated={(merit) => setCreated((c) => ({ count: c.count + 1, title: merit.title }))}
              initialSource={allowedKinds.find(([kind]) => kind === params.get("source_kind"))?.[0] as MeritCreate["source_kind"] | undefined}
              initialScopeId={params.get("scope_id") ?? undefined} />
          </Card>
        )}
      </div>
    </Page>
  );
}
export function SourcesPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const query = useQuery({
    queryKey: ["assessments", "sources", id],
    queryFn: () => seasonsApi.assessments({ season_id: id }),
    enabled: can(session, "view_kkr"),
  });
  if (!can(session, "view_kkr"))
    return (
      <Page title="Подробные начисления">
        <Empty>Нет доступа к расчётным данным.</Empty>
      </Page>
    );
  return (
    <Page title="Подробные начисления">
      <QueryState loading={query.isLoading} error={query.error}>
        <div className={s.stack}>
          {query.data?.items.map((c) => (
            <Card key={c.contribution_id} title={c.source_title}>
              <p>
                {c.user.display_name} · ККР:{" "}
                {c.score?.toFixed(2) ?? "не рассчитан"}
              </p>
              <p className={s.muted}>Версия расчёта: {c.calculation_version}</p>
              {c.assignment_inputs && (
                <p>
                  Часы {c.assignment_inputs.hours ?? "—"} · оценка{" "}
                  {c.assignment_inputs.evaluation ?? "—"} · дата{" "}
                  {displayDate(c.assignment_inputs.effective_completed_at)}
                </p>
              )}
            </Card>
          ))}
          {query.data?.items.length === 0 && (
            <Empty>Начислений пока нет.</Empty>
          )}
          {!can(session, "view_kkr") && (
            <Empty>Нет доступа к расчётным данным.</Empty>
          )}
        </div>
      </QueryState>
    </Page>
  );
}
type CorrectionKind = "task_inputs" | "assessment_inputs" | "merit";
type CorrectionRecord =
  | { kind: "task_inputs"; record: TaskInputs }
  | { kind: "assessment_inputs"; record: AssessmentInputs }
  | { kind: "merit"; record: Merit };
function ClosedCorrectionEditor({
  kind,
  objectId,
  seasonId,
  save,
  summaryVersion,
}: {
  kind: CorrectionKind;
  objectId: string;
  seasonId: string;
  summaryVersion: number;
  save: (revision: number, values: object, reason: string, summaryVersion: number) => Promise<{revision: number; revisionKey: string}>;
}) {
  const { refresh } = useWorkspaceActions();
  const query = useQuery<CorrectionRecord>({
    queryKey: [
      kind === "merit" ? "merits" : "assessments",
      "closed",
      kind,
      objectId,
    ],
    queryFn: async () => {
      if (kind === "task_inputs")
        return { kind, record: await tasksApi.inputs(objectId) };
      if (kind === "assessment_inputs")
        return { kind, record: await tasksApi.assessment(objectId) };
      return { kind, record: await seasonsApi.merit(objectId) };
    },
  });
  const data = query.data;
  let fields: Field[] = [];
  if (data?.kind === "task_inputs")
    fields = [
      {
        name: "assigned",
        label: "Дата выдачи, МСК",
        type: "datetime-local",
        required: true,
        value: moscowInput(data.record.assigned_at),
      },
      {
        name: "deadline",
        label: "Дедлайн, МСК",
        type: "datetime-local",
        required: true,
        value: moscowInput(data.record.deadline_at),
      },
      ...Object.entries(criteriaLabels).map(([name, label]) => ({
        name,
        label,
        type: "select" as const,
        required: true,
        value: String(
          data.record.criteria[name as keyof typeof criteriaLabels],
        ),
        options: [
          { value: "true", label: "Да" },
          { value: "false", label: "Нет" },
        ],
      })),
    ];
  if (data?.kind === "assessment_inputs")
    fields = [
      {
        name: "hours",
        label: "Часы",
        type: "number",
        min: 0,
        required: true,
        value: String(data.record.hours ?? ""),
      },
      {
        name: "evaluation",
        label: "Оценка",
        type: "select",
        required: true,
        value: String(data.record.evaluation ?? ""),
        options: [-1, 0, 1, 1.5].map((n) => ({
          value: String(n),
          label: String(n),
        })),
      },
      {
        name: "completed",
        label: "Дата выполнения, МСК",
        type: "datetime-local",
        value: data.record.effective_completed_at
          ? moscowInput(data.record.effective_completed_at)
          : "",
      },
    ];
  return (
    <QueryState
      keepDataOnError={!!query.data}
      loading={query.isLoading}
      error={query.error}
      retry={() => void query.refetch()}
    >
      {data && (
        <>
          <p>Версия исходной записи: {data.record.revision}</p>
          {data.kind === "merit" ? (
            <MeritForm
              seasonId={seasonId}
              existing={data.record}
              summaryVersion={summaryVersion}
              save={async (value, expectedRevision, expectedVersion) => {
                return save(expectedRevision, meritPatch(value), value.reason, expectedVersion);
              }}
            />
          ) : (
            <>
              <details>
                <summary>Текущие сохранённые значения</summary>
                <dl>
                  {fields.map((f) => (
                    <div key={f.name}>
                      <dt>{f.label}</dt>
                      <dd>
                        {f.options?.find((o) => o.value === f.value)?.label ??
                          f.value ??
                          "—"}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
              <ActionForm
                revision={data.record.revision}
                revisionKey={String(summaryVersion)}
                fields={[
                  ...fields,
                  {
                    name: "reason",
                    label: "Причина корректировки",
                    required: true,
                    type: "textarea",
                  },
                ]}
                onConflict={refresh}
                onSubmit={async (v, expectedRevision, expectedVersion) => {
                  let values: object;
                  if (data.kind === "task_inputs") {
                    const assigned_at = toUtc(text(v, "assigned")),
                      deadline_at = toUtc(text(v, "deadline"));
                    if (assigned_at > deadline_at)
                      throw Error("Дата выдачи позже дедлайна");
                    values = {
                      assigned_at,
                      deadline_at,
                      criteria: Object.fromEntries(
                        Object.keys(criteriaLabels).map((k) => [
                          k,
                          text(v, k) === "true",
                        ]),
                      ),
                    };
                  } else {
                    const evaluation = number(v, "evaluation");
                    if (evaluation > 0 && !text(v, "completed"))
                      throw Error(
                        "Для положительной оценки нужна дата выполнения",
                      );
                    values = {
                      hours: number(v, "hours"),
                      evaluation,
                      effective_completed_at: text(v, "completed")
                        ? toUtc(text(v, "completed"))
                        : null,
                    };
                  }
                  return save(expectedRevision!, values, text(v, "reason"), Number(expectedVersion));
                }}
              />
            </>
          )}
        </>
      )}
    </QueryState>
  );
}
export function CorrectionsPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const { perform } = useWorkspaceActions();
  const [kind, setKind] = useState<CorrectionKind>("assessment_inputs");
  const [objectId, setObjectId] = useState("");
  const chair = can(session, "close_season");
  const summary = useQuery({
    queryKey: ["summary", id],
    queryFn: () => seasonsApi.summary(id),
    enabled: chair && can(session, "view_summary"),
  });
  const allowed = chair && can(summary.data, "correct_summary");
  const tasks = useQuery({
    queryKey: ["tasks", "closed-correction", id],
    queryFn: () => tasksApi.list({ season_id: id, mine: false }),
    enabled: allowed,
  });
  const merits = useQuery({
    queryKey: ["merits", id],
    queryFn: () => seasonsApi.merits({ season_id: id }),
    enabled: allowed,
  });
  const options =
    kind === "merit"
      ? merits.data?.items.map((m) => ({ value: m.merit_id, label: m.title }))
      : kind === "task_inputs"
        ? tasks.data?.items.map((t) => ({ value: t.task_id, label: t.title }))
        : tasks.data?.items.flatMap((t) =>
            t.assignments.map((a) => ({
              value: a.assignment_id,
              label: `${a.assignee.display_name}: ${t.title}`,
            })),
          );
  return (
    <Page
      title="Исправление закрытых итогов"
      actions={
        <RouteLink to={`/seasons/${encodeURIComponent(id)}`}>
          К сезону
        </RouteLink>
      }
    >
      {!chair ? (
        <Empty>Исправление доступно председателю.</Empty>
      ) : (
        <QueryState
          loading={summary.isLoading}
          error={summary.error}
          retry={() => void summary.refetch()}
        >
          {allowed ? (
            <Card>
              <p>
                Версия сводной: {summary.data!.version}. Исправление создаёт
                новую версию. Баллы и бонусы пересчитывает сервер по
                сохранённому составу сезона.
              </p>
              <label className={s.field}>
                Тип исправления
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as CorrectionKind);
                    setObjectId("");
                  }}
                >
                  <option value="assessment_inputs">
                    Оценивание назначения
                  </option>
                  <option value="task_inputs">Даты и критерии задачи</option>
                  <option value="merit">Заслуга или волонтёрская работа</option>
                </select>
              </label>
              <QueryState
                loading={kind === "merit" ? merits.isLoading : tasks.isLoading}
                error={kind === "merit" ? merits.error : tasks.error}
                retry={() =>
                  void (kind === "merit" ? merits.refetch() : tasks.refetch())
                }
              >
                <label className={s.field}>
                  {kind === "assessment_inputs"
                    ? "Оцениваемое назначение"
                    : kind === "task_inputs"
                      ? "Задача"
                      : "Запись заслуги"}
                  <select
                    value={objectId}
                    onChange={(e) => setObjectId(e.target.value)}
                  >
                    <option value="">Выберите…</option>
                    {options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                {options?.length === 0 && (
                  <Empty>Нет доступных записей этого типа.</Empty>
                )}
                {objectId && (
                  <ClosedCorrectionEditor
                    key={`${kind}/${objectId}`}
                    kind={kind}
                    objectId={objectId}
                    seasonId={id}
                    summaryVersion={summary.data!.version}
                    save={async (revision, values, reason, expectedVersion) => {
                      if (!can(summary.data, "correct_summary"))
                        throw Error(
                          "Право исправления отозвано. Обновите данные.",
                        );
                      const saved = await perform(() =>
                        seasonsApi.correctSummary(id, {
                          expected_version: expectedVersion,
                          reason,
                          changes: [
                            {
                              kind,
                              id: objectId,
                              expected_revision: revision,
                              values,
                            },
                          ],
                        }),
                      );
                      const applied = saved.applied_revisions.find(r => r.id === objectId && r.kind === kind);
                      if (!applied) throw Error("Сервер не подтвердил версию исправленной записи. Обновите данные.");
                      return {revision: applied.revision, revisionKey: String(saved.version)};
                    }}
                  />
                )}
              </QueryState>
            </Card>
          ) : (
            <Empty>
              Исправление доступно председателю после закрытия сезона.
            </Empty>
          )}
        </QueryState>
      )}
    </Page>
  );
}
export function SeasonCorrectionForm() {
  const { session } = useSession();
  const { perform, refresh } = useWorkspaceActions();
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const objects = useQuery({
    queryKey: ["events", "correction-objects"],
    queryFn: async () => {
      const [events, tasks, merits] = await Promise.all([
        eventsApi.list(),
        tasksApi.list({ mine: false }),
        seasonsApi.merits(),
      ]);
      return [
        ...events.items.map((e) => ({
          kind: "event" as const,
          id: e.event_id,
          title: e.title,
          revision: e.revision,
        })),
        ...tasks.items
          .filter((t) => t.scope.kind === "block")
          .map((t) => ({
            kind: "block_task" as const,
            id: t.task_id,
            title: t.title,
            revision: t.revision,
          })),
        ...merits.items
          .filter((m) =>
            ["block_volunteer", "chair_merit"].includes(m.source_kind),
          )
          .map((m) => ({
            kind: "merit" as const,
            id: m.merit_id,
            title: m.title,
            revision: m.revision,
          })),
      ];
    },
    enabled: can(session, "correct_season"),
  });
  if (!can(session, "correct_season")) return null;
  return (
    <Card title="Исправить ошибочную принадлежность к сезону">
      <p>
        Для мероприятия изменятся также сезоны связанных задач, отчётов и
        начислений. Оба сезона должны быть незакрыты; операция выполняется
        целиком.
      </p>
      <QueryState keepDataOnError={!!objects.data} loading={objects.isLoading} error={objects.error}>
        <ActionForm
          revisionKey={revisionSnapshot(objects.data?.map(o => ({id: `${o.kind}/${o.id}`, revision: o.revision})) ?? [])}
          onConflict={refresh}
          fields={[
            {
              name: "object",
              label: "Объект",
              type: "select",
              required: true,
              options: objects.data?.map((o) => ({
                value: `${o.kind}/${o.id}`,
                label: o.title,
              })),
            },
            {
              name: "target",
              label: "Правильный сезон",
              type: "select",
              required: true,
              options: seasons.data?.items
                .filter((s) => s.state !== "closed")
                .map((s) => ({ value: s.season_id, label: s.title })),
            },
            {
              name: "reason",
              label: "Причина",
              type: "textarea",
              required: true,
            },
          ]}
          onSubmit={async (v, _expectedRevision, snapshot) => {
            const object = objects.data?.find(
              (o) => `${o.kind}/${o.id}` === text(v, "object"),
            );
            if (!object) throw Error("Выберите объект");
            if (
              object.kind !== "event" &&
              seasons.data?.items.find((s) => s.season_id === text(v, "target"))
                ?.state === "planned"
            )
              throw Error(
                "Этой записи нужен открытый сезон или подведение итогов",
              );
            const revisions = snapshotRevisions(snapshot);
            const objectKey = `${object.kind}/${object.id}`;
            if (!revisions.has(objectKey)) throw Error("Обновите список объектов");
            const saved = await perform(() =>
              seasonsApi.correctSeason({
                object_kind: object.kind,
                object_id: object.id,
                expected_revision: revisions.get(objectKey)!,
                target_season_id: text(v, "target"),
                reason: text(v, "reason"),
              }),
            );
            revisions.set(objectKey, saved.revision);
            return {revisionKey: revisionSnapshot([...revisions].map(([id, revision]) => ({id, revision})))};
          }}
        />
      </QueryState>
    </Card>
  );
}
