import { EntityPicker, type EntityOption } from "../../components/Workspace/EntityPicker";
import { useState, type ComponentProps } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import {
  Page,
  Card,
  QueryState,
  ErrorState,
  Empty,
  RouteLink,
} from "../../components/Workspace/WorkspaceUI";
import { Markdown } from "../../components/Workspace/WorkspaceMarkdown";
import { ActionForm, type Field } from "../../components/Workspace/ActionForm";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { revisionSnapshot, snapshotRevisions } from "../../components/Workspace/revisionSnapshot";
import { text, number, ids, type Values } from "../../components/Workspace/formValues";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { eventsApi } from "../../utils/api/events.api";
import {
  emptyCriteria,
  richText,
  type Merit,
  type MeritContexts,
  type Session,
  type Season,
  type MeritCreate,
  type MeritPatch,
  type TaskInputs,
  type AssessmentInputs,
} from "../../utils/api/contract";
import { canRetainData, normalizeApiError } from "../../utils/api/request";
import { readsMerits } from "./meritAccess";
import { evaluationOptions } from "../../utils/evaluations";
import { criteriaLabels } from "../../utils/kkrCriteria";
import { UserChip } from "../../components/Workspace/UserChip";
import { can, useSession } from "../../utils/session";
import { toUtc, displayDate, moscowInput } from "../../utils/dates";
import {
  usePeopleOptions,
  useWorkspaceActions,
} from "../../utils/hooks/useWorkspace";
import { useDebouncedValue } from "../../utils/hooks/useDebouncedValue";
import s from "../../components/Workspace/Workspace.module.css";
import { KkrTemplateTools } from "../../components/Workspace/KkrTemplateLibrary";
import type { TemplateSelection } from "../../utils/api/profileFeatures.api";
import { HistoryDisclosure } from "../../components/Workspace/HistoryPanel";
import { metricValue, sourceNames } from "./seasonAnalyticsView";
import u from "./SeasonWorkspace.module.css";
const kinds: Record<MeritCreate["source_kind"], string> = {
  head_merit: "Особая заслуга на мероприятии",
  chair_merit: "Заслуга председателя",
  block_volunteer: "Волонтёрская работа блока",
  subevent_volunteer: "Волонтёрская работа подмероприятия",
};
/** PATCH /merits/{id} takes only these fields; kind, season and scope stay as created (A-KKR-1). */
function meritPatch({ title, description, assigned_at, deadline_at, criteria, recipients, template_selection }: MeritCreate & { template_selection?: TemplateSelection }): MeritPatch & { template_selection?: TemplateSelection } {
  return { title, description, assigned_at, deadline_at, criteria, recipients, ...(template_selection ? { template_selection } : {}) };
}
type MeritScopes = { blocks: MeritContexts["blocks"]; events: MeritContexts["events"]; subs: MeritContexts["subevents"] };
/** One GET /merits/contexts (PB-11) instead of /blocks, /events and the subevents of every event. */
function useMeritContexts(seasonId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["merits", "contexts", seasonId ?? null],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<MeritScopes> => {
      const { blocks, events, subevents } = await seasonsApi.meritContexts(seasonId);
      return { blocks, events, subs: subevents };
    },
  });
}
type MeritContextsQuery = ReturnType<typeof useMeritContexts>;
function allowedMeritKinds(session: Session | null, contexts: MeritScopes | undefined, season?: Season) {
  if (!season || season.state === "closed") return [];
  const eventIds = new Set(contexts?.events.filter((e) => e.season_id === season.season_id).map((e) => e.event_id));
  return Object.entries(kinds).filter(([kind]) => {
    if (kind === "chair_merit") return can(session, "create_chair_merit") && season.state !== "planned";
    if (kind === "head_merit") return contexts?.events.some((e) => eventIds.has(e.event_id) && can(e, "create_head_merit"));
    if (kind === "subevent_volunteer") return contexts?.subs.some((sub) => eventIds.has(sub.event_id) && can(sub, "create_volunteer_merit"));
    return season.state !== "planned" && contexts?.blocks.some((b) => can(b, "create_volunteer_merit"));
  });
}

/** A season subpage whose season is not in the list: say so instead of an empty form. */
function SeasonMissing() {
  return <Page title="Сезон не найден" actions={<RouteLink to="/seasons">Все сезоны</RouteLink>}><Empty>Такого сезона нет. Возможно, ссылка устарела.</Empty></Page>;
}
/** The season of a subpage from the shared list; `missing` once the list is known and lacks it. */
function useSubpageSeason(id: string) {
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const season = seasons.data?.items.find((item) => item.season_id === id);
  return { seasons, season, missing: !!seasons.data && !season };
}

/** Blocks have no fixed season; pick an eligible one before opening its form. */
export function MeritEntryPage() {
  const { session } = useSession();
  const [params] = useSearchParams();
  const contexts = useMeritContexts(undefined);
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const requested = params.get("source_kind");
  const scopeId = params.get("scope_id");
  const creatable = seasons.data?.items.filter((season) => allowedMeritKinds(session, contexts.data, season).some(([kind]) => {
    if (requested && requested !== kind) return false;
    if (!scopeId) return true;
    return kind === "block_volunteer" ? contexts.data?.blocks.some((b) => b.block_id === scopeId && can(b, "create_volunteer_merit"))
      : kind === "head_merit" ? contexts.data?.events.some((e) => e.event_id === scopeId && e.season_id === season.season_id && can(e, "create_head_merit"))
      : kind === "subevent_volunteer" && contexts.data?.subs.some((sub) => sub.subevent_id === scopeId && contexts.data?.events.some((e) => e.event_id === sub.event_id && e.season_id === season.season_id) && can(sub, "create_volunteer_merit"));
  })) ?? [];
  // The seasons where the user records work decide the step (every creator also reads merits);
  // only a reader who records nowhere chooses among every season, closed ones too.
  const eligible = creatable.length || requested || scopeId || !readsMerits(session) ? creatable : seasons.data?.items ?? [];
  const seasonMerits = (seasonId: string) => `/seasons/${encodeURIComponent(seasonId)}/merits${params.size ? `?${params}` : ""}`;
  // With one season to choose there is nothing to choose: open it in place of this step.
  if (contexts.data && seasons.data && eligible.length === 1) return <Navigate replace to={seasonMerits(eligible[0].season_id)} />;
  return <Page title="Учёт выполненной работы" description="Выберите сезон. Доступны только исходные поля разрешённых вам записей.">
    <QueryState loading={contexts.isLoading || seasons.isLoading} error={contexts.error || seasons.error}>
      <div className={s.grid}>{eligible.map((season) => <Card key={season.season_id} title={season.title}>
        <RouteLink to={seasonMerits(season.season_id)}>Особые заслуги и волонтёры</RouteLink>
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
  contexts: shared,
}: {
  seasonId: string;
  /** The page's own contexts query, so an editor never repeats it. */
  contexts?: MeritContextsQuery;
  existing?: Merit;
  onCreated?: (merit: Merit) => void;
  save?: (data: MeritCreate & { reason: string }, revision: number, summaryVersion: number) => Promise<{revision: number; revisionKey: string}>;
  summaryVersion?: number;
  initialSource?: MeritCreate["source_kind"];
  initialScopeId?: string;
}) {
  const { session } = useSession();
  const requestContextChange = useGuardedAction();
  const [templateSelection, setTemplateSelection] = useState<TemplateSelection | null>(null);
  const { perform, refresh } = useWorkspaceActions();
  const people = usePeopleOptions({ includeNonMembers: true });
  // An existing record needs the lists only for its scope name, so they never block its form.
  const own = useMeritContexts(seasonId, !shared);
  const contexts = shared ?? own;
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list, enabled: !existing });
  const season = seasons.data?.items.find((x) => x.season_id === seasonId);
  const allowedKinds = allowedMeritKinds(session, contexts.data, season);
  const [selectedPeople, setSelectedPeople] = useState<EntityOption[]>(() =>
    (existing?.recipients ?? []).map((r) => {
      const person = people.data?.find((p) => p.user_id === r.user_id);
      return { value: String(r.user_id), label: person ? `${person.surname} ${person.name}` : `Участник #${r.user_id} · сохранённый получатель`, user: { user_id: r.user_id, display_name: person ? `${person.surname} ${person.name}` : `Участник #${r.user_id}`, avatar_url: person?.photo_url ?? null } };
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
        user: { user_id: recipient.user_id, display_name: person ? `${person.surname} ${person.name}` : `Участник #${recipient.user_id}`, avatar_url: person?.photo_url ?? null },
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
  const scopeOptions: EntityOption[] | undefined =
    source === "block_volunteer"
      ? contexts.data?.blocks
          .filter((x) => can(x, "create_volunteer_merit"))
          .map((x) => ({ value: x.block_id, label: x.name, block: x }))
      : source === "subevent_volunteer"
        ? contexts.data?.subs
            .filter((x) => contexts.data?.events.some((e) => e.event_id === x.event_id && e.season_id === seasonId) && can(x, "create_volunteer_merit"))
            .map((x) => ({ value: x.subevent_id, label: x.title, scope: { kind: "subevent", name: x.title } }))
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
      compact: "period",
      value: existing ? moscowInput(existing.assigned_at) : "",
    },
    {
      name: "deadline",
      label: "Дедлайн, МСК",
      type: "datetime-local",
      required: true,
      compact: "period",
      value: existing ? moscowInput(existing.deadline_at) : "",
    },
    ...Object.entries(criteriaLabels).map(([name, label]) => ({
      name,
      label,
      type: "select" as const,
      compact: "criteria",
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
        compact: `recipient_${p.value}`,
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
        compact: `recipient_${p.value}`,
        value: String(
          existing?.recipients.find((r) => r.user_id === Number(p.value))
            ?.evaluation ?? "",
        ),
        options: evaluationOptions,
      },
      {
        name: `completed_${p.value}`,
        whenSelected: { name: "users", value: p.value },
        label: `Дата выполнения, МСК: ${p.label}`,
        type: "datetime-local" as const,
        compact: `recipient_${p.value}`,
        // A positive evaluation needs the date of the result; the field says so before the submit does.
        required: (values: Values) => Number(values[`evaluation_${p.value}`]) > 0,
        value: existing?.recipients.find((r) => r.user_id === Number(p.value))
          ?.completed_at
          ? moscowInput(
              existing.recipients.find((r) => r.user_id === Number(p.value))!
                .completed_at!,
            )
          : "",
      },
    ]),
    ...(existing ? [{ name: "reason", label: "Причина исправления", required: true, type: "textarea" as const }] : []),
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
                setTemplateSelection(null);
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
          <EntityPicker name="scope" label="Область работы" disabled={!!existing} value={scopeId} placeholder="Выберите область"
            onChange={next => requestContextChange(() => { setScopeId(next); setSelectedPeople([]);setTemplateSelection(null); })}
            options={existing
              ? [{ value: scopeId, label: savedScope ?? (contexts.isLoading ? "Загрузка названия…" : "Сохранённая область"), ...(source === "block_volunteer" ? { block: { block_id: scopeId, name: savedScope ?? "Сохранённый блок" } } : {}) }]
              : [{ value: "", label: "Не выбрана" }, ...(scopeOptions ?? [])]}
          />
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
            changeRequired={existing ? fields.filter(field => field.name !== "reason").map(field => field.name) : undefined}
            externalState={templateSelection} savedExternalState={null} onReplaceWithSaved={() => setTemplateSelection(null)}
            beforeFields={form => <KkrTemplateTools form={form} mode="merit" selection={templateSelection} onSelection={setTemplateSelection} />}
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
              const data: MeritCreate & { template_selection?: TemplateSelection } = {
                season_id: fixedSeason ?? seasonId,
                ...(templateSelection ? { template_selection: templateSelection } : {}),
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
                ...(existing ? { reason: text(v, "reason") } : {}),
              };
              if (save) {
                return save({ ...data, reason: text(v, "reason") }, expectedRevision!, Number(expectedVersion));
              }
              if (existing)
                return perform(() =>
                  seasonsApi.updateMerit(existing.merit_id, {
                    ...meritPatch(data),
                    reason: text(v, "reason"),
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
  const { seasons, season, missing } = useSubpageSeason(id);
  // An unknown season asks nothing about itself: the contexts wait for the season list (GL-21).
  const contexts = useMeritContexts(id, !!season);
  const people = usePeopleOptions({ includeNonMembers: true });
  const [created, setCreated] = useState<{ count: number; title?: string }>({ count: 0 });
  const allowedKinds = allowedMeritKinds(session, contexts.data, season);
  // The server filters the list by the reader's scopes, so the page always asks it; only a 403 means no access.
  const query = useQuery({
    queryKey: ["merits", id],
    queryFn: () => seasonsApi.merits({ season_id: id }),
    enabled: !!season,
  });
  if (missing) return <SeasonMissing />;
  if (contexts.isLoading || seasons.isLoading) return <QueryState loading error={null}>{null}</QueryState>;
  if ((contexts.error && (!contexts.data || !canRetainData(contexts.error))) || (seasons.error && (!seasons.data || !canRetainData(seasons.error)))) return <QueryState loading={false} error={contexts.error || seasons.error}>{null}</QueryState>;
  if (query.error && normalizeApiError(query.error).status === 403 && !allowedKinds.length) return <Page title="Особые заслуги"><Empty>Нет доступа к исходным полям.</Empty></Page>;
  return (
    <Page
      title="Особые заслуги и волонтёры"
      description={season && `Сезон «${season.title}»`}
      actions={<RouteLink to={`/seasons/${encodeURIComponent(id)}`}>К сезону</RouteLink>}
    >
      <div className={s.stack}>
        {(contexts.error || seasons.error) && <ErrorState error={contexts.error || seasons.error} />}
        <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data}>
          {query.data?.items.length === 0 && <Empty>Записей пока нет.</Empty>}
          {query.data?.items.map((m) => (
            <Card key={m.merit_id} title={m.title}>
              <p>
                {kinds[m.source_kind]} · {displayDate(m.assigned_at)}
              </p>
              <ul className={s.list} aria-label="Получатели">
                {m.recipients.map((r) => {
                  const person = people.options.find((p) => p.value === String(r.user_id))?.user;
                  return <li key={r.user_id} className={s.row}>{person ? <UserChip user={person} /> : <span>Участник #{r.user_id}</span>}<span className={s.muted}>{r.hours} ч · оценка {String(r.evaluation).replace(".", ",")}{r.completed_at ? ` · выполнено ${displayDate(r.completed_at)}` : ""}</span></li>;
                })}
              </ul>
              <Markdown content={m.description} />
              <HistoryDisclosure kind="merit" id={m.merit_id} />
              {can(m, "edit_assessment_inputs") && (
                <details className={s.details}>
                  <summary>Исправить исходные поля</summary>
                  <MeritForm seasonId={id} existing={m} contexts={contexts} />
                </details>
              )}
            </Card>
          ))}
        </QueryState>
        {allowedKinds.length > 0 && (
          <Card title="Учесть выполненную работу">
            {created.title && <p role="status" className={s.success}>Работа записана: {created.title}</p>}
            <MeritForm key={`${id}/${params.get("source_kind")}/${params.get("scope_id")}/${created.count}`} seasonId={id} contexts={contexts}
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
  const [params, setParams] = useSearchParams();
  const requestedKind = params.get("source_kind") ?? "";
  const sourceKind = requestedKind !== "unallocated" && Object.keys(sourceNames).includes(requestedKind) ? requestedKind : "";
  const participantId = params.get("participant_id") ?? "";
  const setFilter = (name: string, value: string) => setParams(previous => {
    const next = new URLSearchParams(previous);
    if (value) next.set(name, value);else next.delete(name);
    return next;
  });
  const { seasons, season, missing } = useSubpageSeason(id);
  const participants = useQuery({ queryKey: ["summary", id], queryFn: () => seasonsApi.summary(id), enabled: !!season && can(session, "view_kkr") && can(session, "view_summary") });
  const participantOptions = (!participants.error || canRetainData(participants.error) ? participants.data?.rows : undefined)?.map(row => ({ value: row.participant_id, label: `${row.user.display_name}${row.group_number ? ` · ${row.group_number}` : ""}`, user: row.user })) ?? [];
  const query = useQuery({
    queryKey: ["assessments", "sources", id, sourceKind, participantId],
    queryFn: () => seasonsApi.assessments({ season_id: id, ...(sourceKind ? { source_kind: sourceKind } : {}), ...(participantId ? { participant_id: participantId } : {}) }),
    enabled: !!season && can(session, "view_kkr"),
  });
  if (missing) return <SeasonMissing />;
  const back = <RouteLink to={`/seasons/${encodeURIComponent(id)}`}>К сезону</RouteLink>;
  if (!can(session, "view_kkr"))
    return (
      <Page title="Подробные начисления" actions={back}>
        <Empty>Нет доступа к расчётным данным.</Empty>
      </Page>
    );
  return (
    <Page title="Подробные начисления" description={season && `Сезон «${season.title}»`} actions={back}>
      <div className={s.filters} aria-label="Фильтры начислений">
        <label className={s.field}>Вид источника<select name="source_kind" value={sourceKind} onChange={event => setFilter("source_kind", event.target.value)}><option value="">Все источники</option>{Object.entries(sourceNames).filter(([kind]) => kind !== "unallocated").map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
        <EntityPicker name="participant_id" label="Участник" value={participantId} onChange={value => setFilter("participant_id", value)} loading={participants.isLoading} placeholder="Все участники" options={[{ value: "", label: "Все участники" }, ...participantOptions]} />
      </div>
      {participants.error && <ErrorState error={participants.error} />}
      <QueryState loading={seasons.isLoading || query.isLoading} error={query.error ?? seasons.error}>
        {/* One line per contribution instead of a card each (SE-22). */}
        {!!query.data?.items.length && (
          <div className={u.summaryWrap} tabIndex={0} role="region" aria-label="Начисления, горизонтальная прокрутка">
            <table className={u.sourcesTable}>
              <thead><tr>{["Участник", "Источник", "Часы", "Оценка", "Дата", "ККР"].map((name) => <th key={name} scope="col">{name}</th>)}</tr></thead>
              <tbody>
                {query.data.items.map((c) => (
                  <tr key={c.contribution_id}>
                    <td><UserChip user={c.user} /></td>
                    <td>{c.source_title}<small>{sourceNames[c.source_kind] ?? c.source_kind}</small></td>
                    <td>{metricValue(c.assignment_inputs?.hours)}</td>
                    <td>{metricValue(c.assignment_inputs?.evaluation)}</td>
                    <td>{c.assignment_inputs?.effective_completed_at ? displayDate(c.assignment_inputs.effective_completed_at) : "—"}</td>
                    <td>{c.score === null ? "не рассчитан" : metricValue(c.score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {query.data?.items.length === 0 && <Empty>Начислений пока нет.</Empty>}
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
        value: data.record.deadline_at ? moscowInput(data.record.deadline_at) : "",
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
                changeRequired={fields.map(field => field.name)}
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
  const [search, setSearch] = useState("");
  // Who corrects a closed season is the summary's correct_summary (SE-13): the chair, deputies, HR master.
  const reader = can(session, "view_summary");
  const { seasons, season, missing } = useSubpageSeason(id);
  const summary = useQuery({
    queryKey: ["summary", id],
    queryFn: () => seasonsApi.summary(id),
    enabled: !!season && reader,
  });
  const allowed = can(summary.data, "correct_summary");
  // Task-based kinds search the season's readable tasks on the server by name or key, 20 at a time and
  // without the KKR control epics, instead of listing the whole season (PF-06). Typing settles for
  // 250 ms; the last list stays meanwhile.
  const settledSearch = useDebouncedValue(search);
  const tasks = useQuery({
    queryKey: ["tasks", "closed-correction", id, settledSearch],
    queryFn: ({ signal }) => tasksApi.listPage({ season_id: id, ...(settledSearch ? { q: settledSearch } : {}), limit: 20, include_facets: false, exclude_kkr_control: true }, signal),
    enabled: allowed && kind !== "merit",
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const searching = kind !== "merit" && (search !== settledSearch || tasks.isPlaceholderData);
  const partial = kind !== "merit" && !searching && !!tasks.data?.next_cursor;
  const merits = useQuery({
    queryKey: ["merits", id],
    queryFn: () => seasonsApi.merits({ season_id: id }),
    enabled: allowed,
  });
  // The saved hours and evaluation tell apart two assignments of one person (the sources page reads the same list).
  const contributions = useQuery({
    queryKey: ["assessments", "sources", id, "", ""],
    queryFn: () => seasonsApi.assessments({ season_id: id }),
    enabled: allowed && kind === "assessment_inputs" && can(session, "view_kkr"),
  });
  const inputs = new Map((contributions.data?.items ?? []).flatMap((c) => c.assignment_inputs ? [[c.assignment_inputs.assignment_id, c.assignment_inputs] as const] : []));
  // Control epics keep no accounting of their own (no view_assessment_inputs), and only accepted or
  // not completed assignments carry an evaluation to correct.
  const accountable = tasks.data?.items.filter((t) => can(t, "view_assessment_inputs")) ?? [];
  const savedValues = (saved: AssessmentInputs) => `${saved.hours ?? "—"} ч / оценка ${saved.evaluation ?? "—"}`;
  const taskAssignments: EntityOption[] = accountable.flatMap((t) =>
    t.assignments.filter((a) => a.status === "accepted" || a.status === "not_completed").map((a) => {
      const saved = inputs.get(a.assignment_id);
      return {
        value: a.assignment_id,
        // Plain text, not a person chip: the label must also name the task and the saved values.
        label: `${a.assignee.display_name} · ${t.title} · ${saved ? savedValues(saved) : a.status === "accepted" ? "принято" : "не выполнено"}`,
      };
    }),
  );
  // The server searches task names and keys only. A person is found in the season's assessments that
  // this page already reads for the labels: every typed word in the person's name or the task title.
  // A hidden source carries no assignment_inputs and is never offered; a saved evaluation marks an
  // accepted or not completed assignment. Server matches come first, one row per assignment.
  const words = settledSearch.trim().toLocaleLowerCase("ru").split(/\s+/).filter(Boolean);
  const personOption = (c: { user: { display_name: string }; source_title: string }, saved: AssessmentInputs): EntityOption =>
    ({ value: saved.assignment_id, label: `${c.user.display_name} · ${c.source_title} · ${savedValues(saved)}` });
  const personAssignments: EntityOption[] = !words.length ? [] : (contributions.data?.items ?? []).flatMap((c) => {
    const saved = c.assignment_inputs;
    if (!saved || saved.evaluation === null) return [];
    const text = `${c.user.display_name} ${c.source_title}`.toLocaleLowerCase("ru");
    return words.every((word) => text.includes(word)) ? [personOption(c, saved)] : [];
  });
  // The chosen assignment's chip names its hours and evaluation as they are now: after a
  // correction, also when the cleared search no longer lists it (PF-06 review).
  const chosenOptions: EntityOption[] = kind !== "assessment_inputs" || !objectId ? [] : (contributions.data?.items ?? []).flatMap((c) =>
    c.assignment_inputs?.assignment_id === objectId ? [personOption(c, c.assignment_inputs)] : []);
  const assessmentOptions: EntityOption[] = [];
  for (const option of [...taskAssignments, ...personAssignments])
    if (!assessmentOptions.some((known) => known.value === option.value)) assessmentOptions.push(option);
  const options: EntityOption[] | undefined = !tasks.data && kind !== "merit" ? undefined
    : kind === "merit"
      ? merits.data?.items.map((m) => ({ value: m.merit_id, label: m.title }))
      : kind === "task_inputs"
        ? accountable.map((t) => ({ value: t.task_id, label: t.title }))
        : assessmentOptions;
  if (missing) return <SeasonMissing />;
  return (
    <Page
      title="Исправление закрытых итогов"
      description={season && `Сезон «${season.title}»`}
      actions={
        <RouteLink to={`/seasons/${encodeURIComponent(id)}`}>
          К сезону
        </RouteLink>
      }
    >
      {!reader ? (
        <Empty>Исправление доступно председателю, его заместителям и мастеру HR.</Empty>
      ) : (
        <QueryState
          loading={seasons.isLoading || summary.isLoading}
          error={summary.error ?? seasons.error}
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
                keepDataOnError={kind !== "merit" && !!tasks.data}
                retry={() =>
                  void (kind === "merit" ? merits.refetch() : tasks.refetch())
                }
              >
                <EntityPicker
                  name="correction_object"
                  label={kind === "assessment_inputs" ? "Оцениваемое назначение: исполнитель · задача · часы / оценка" : kind === "task_inputs" ? "Задача" : "Запись заслуги"}
                  value={objectId}
                  onChange={setObjectId}
                  placeholder={kind === "merit" ? "Найти запись" : kind === "assessment_inputs" ? "Исполнитель, название или ключ задачи" : "Название или ключ задачи"}
                  loading={searching || (kind === "assessment_inputs" && contributions.isLoading)}
                  options={options ?? []}
                  {...(kind === "merit" ? {} : {
                    onSearch: setSearch,
                    selectedOptions: chosenOptions,
                    note: partial ? `Показана часть задач сезона. Уточните ${kind === "assessment_inputs" ? "исполнителя, " : ""}название или ключ.` : undefined,
                  })}
                />
                {options?.length === 0 && (kind === "merit" || (!settledSearch && !partial)) && (
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
              {season && season.state !== "closed"
                ? "Сезон ещё не закрыт: исправления закрытых итогов станут доступны после его закрытия."
                : "Исправление закрытого сезона доступно председателю, его заместителям и мастеру HR."}
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
  const [selectedObject, setSelectedObject] = useState("");
  const allowed = can(session, "correct_season");
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list, enabled: allowed });
  const objects = useQuery({
    queryKey: ["events", "correction-objects"],
    queryFn: async () => {
      const [events, tasks, merits] = await Promise.all([
        eventsApi.list(),
        tasksApi.list({ mine: false, limit: 100 }),
        seasonsApi.merits(),
      ]);
      return [
        ...events.items.map((e) => ({
          kind: "event" as const,
          id: e.event_id,
          title: e.title,
          season_id: e.season_id,
          revision: e.revision,
        })),
        ...tasks.items
          .filter((t) => t.scope.kind === "block")
          .map((t) => ({
            kind: "block_task" as const,
            id: t.task_id,
            title: t.title,
            season_id: t.season_id,
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
            season_id: m.season_id,
            revision: m.revision,
          })),
      ];
    },
    enabled: allowed,
  });
  const sourceSeasons = (!seasons.error || canRetainData(seasons.error) ? seasons.data?.items : undefined) ?? [];
  const currentObjects = (!objects.error || canRetainData(objects.error) ? objects.data : undefined)?.filter(object => sourceSeasons.some(season => season.season_id === object.season_id && season.state !== "closed")) ?? [];
  const selected = currentObjects.find(object => `${object.kind}/${object.id}` === selectedObject);
  const preview = useQuery({ queryKey: ["events", "correction-preview", selected?.id, selected?.revision], queryFn: () => seasonsApi.correctionPreview(selected!.id), enabled: allowed && selected?.kind === "event" });
  const targets = sourceSeasons.filter(season => selected && season.season_id !== selected.season_id && season.state !== "closed" && (selected.kind === "event" || season.state !== "planned"));
  if (!allowed) return null;
  return (
    <Card title="Исправить ошибочную принадлежность к сезону">
      <p>
        Для мероприятия изменятся также сезоны связанных задач, отчётов и
        начислений. Оба сезона должны быть незакрыты; операция выполняется
        целиком.
      </p>
      <QueryState keepDataOnError={!!objects.data && !!seasons.data} loading={objects.isLoading || seasons.isLoading} error={objects.error ?? seasons.error}>
        <ActionForm
          revisionKey={revisionSnapshot(currentObjects.map(o => ({id: `${o.kind}/${o.id}`, revision: o.revision})))}
          onConflict={refresh}
          fields={[
            {
              name: "object",
              label: "Объект",
              type: "select",
              required: true,
              options: currentObjects.map((o) => ({
                value: `${o.kind}/${o.id}`,
                label: `${o.title} · ${sourceSeasons.find(season => season.season_id === o.season_id)!.title}`,
              })),
              onSelectionChange: values => setSelectedObject(values[0] ?? ""),
            },
            {
              name: "target",
              label: "Правильный сезон",
              type: "select",
              required: true,
              options: targets.map((s) => ({ value: s.season_id, label: s.title })),
            },
            {
              name: "reason",
              label: "Причина",
              type: "textarea",
              required: true,
            },
          ]}
          onSubmit={async (v, _expectedRevision, snapshot) => {
            const object = currentObjects.find(
              (o) => `${o.kind}/${o.id}` === text(v, "object"),
            );
            if (!object) throw Error("Выберите объект");
            if (!targets.some(season => season.season_id === text(v, "target"))) throw Error("Выберите другой незакрытый сезон");
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
        >{selected?.kind === "event" && <section aria-label="Связанные данные мероприятия"><QueryState loading={preview.isLoading} error={preview.error} retry={() => void preview.refetch()}>{preview.data && <p>Вместе с мероприятием будут перенесены: подмероприятия — {preview.data.counts.subevents}, задачи — {preview.data.counts.tasks}, отчёты — {preview.data.counts.reports}, заслуги — {preview.data.counts.merits}.</p>}</QueryState></section>}</ActionForm>
      </QueryState>
    </Card>
  );
}
