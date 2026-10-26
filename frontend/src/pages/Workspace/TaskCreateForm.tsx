import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, QueryState } from "../../components/Workspace/WorkspaceUI";
import { ActionForm, type Field } from "../../components/Workspace/ActionForm";
import { text, ids, number } from "../../components/Workspace/formValues";
import { useScopeMembers } from "../../components/Workspace/ScopeMembers";
import { tasksApi } from "../../utils/api/tasks.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { membershipApi } from "../../utils/api/membership.api";
import { eventsApi } from "../../utils/api/events.api";
import { richText, emptyCriteria, type ScopeRef } from "../../utils/api/contract";
import { can } from "../../utils/session";
import { toUtc } from "../../utils/dates";
import { getTaskRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TrackerTaskDetail.module.css";
const criteriaLabels = {
  unique: "Уникальная",
  creative: "Творческая",
  external_communication: "Общение вне вуза",
  in_person: "Очное присутствие",
  fixed_time: "В определённое время",
};
export function TaskCreateForm({ scope, queueId, parentTaskId }: { scope: ScopeRef; queueId?: string; parentTaskId?: string }) {
  const navigate = useNavigate();
  const { perform } = useWorkspaceActions();
  const members = useScopeMembers(scope);
  const [selectedSeason, setSelectedSeason] = useState("");
  const [parentId, setParentId] = useState(parentTaskId ?? ""), [parentSearch, setParentSearch] = useState("");
  const queues = useQuery({ queryKey: ["tasks", "queues", "catalog"], queryFn: taskQueuesApi.catalog });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const context = useQuery({
    queryKey: ["tasks", "create-scope", scope.kind, scope.id],
    queryFn: async () => {
      if (scope.kind === "block")
        return { source: await membershipApi.block(scope.id), season: null };
      const source = await eventsApi.subevent(scope.id);
      return {
        source,
        season: (await eventsApi.get(source.event_id)).season_id,
      };
    },
  });
  const queueOptions = (queues.data?.items ?? []).filter(queue => can(queue, "create_task") && queue.scope?.kind === scope.kind && queue.scope.id === scope.id && (!queueId || queue.queue_id === queueId));
  const seasonId = context.data?.season ?? selectedSeason;
  const presetParent = useQuery({ queryKey: ["tasks", parentId], queryFn: () => tasksApi.get(parentId), enabled: !!parentId });
  const parentCandidates = useQuery({ queryKey: ["tasks", "create-parent-candidates", seasonId, parentSearch], queryFn: () => tasksApi.listPage({ season_id: seasonId, q: parentSearch || undefined, limit: 100 }), enabled: !!seasonId });
  const parents = (parentCandidates.data?.items ?? []).filter(candidate => candidate.season_id === seasonId);
  if (presetParent.data?.season_id === seasonId && !parents.some(candidate => candidate.task_id === presetParent.data!.task_id)) parents.unshift(presetParent.data);
  if (queues.isLoading) return <QueryState loading error={null}>{null}</QueryState>;
  if (!queueOptions.length) return queues.error ? <QueryState loading={false} error={queues.error} retry={() => { void queues.refetch(); }}>{null}</QueryState> : null;
  const fields: Field[] = [
    { name: "queue", label: "Очередь", type: "select", required: true, value: queueId ?? queueOptions[0].queue_id, options: queueOptions.map(queue => ({ value: queue.queue_id, label: `${queue.key} · ${queue.name}` })) },
    { name: "title", label: "Название", required: true },
    {
      name: "description",
      label: "Описание",
      type: "textarea",
      required: true,
    },
    ...(scope.kind === "block"
      ? [
          {
            name: "season",
            label: "Открытый сезон",
            onSelectionChange: (values: string[]) => { setSelectedSeason(values[0] ?? "");setParentId(""); },
            type: "select" as const,
            required: true,
            options: seasons.data?.items
              .filter((x) => x.state === "open")
              .map((x) => ({ value: x.season_id, label: x.title })),
          },
        ]
      : []),
    {
      name: "deadline",
      label: "Дедлайн, МСК",
      type: "datetime-local",
      required: true,
    },
    {
      name: "users",
      label: "Исполнители из команды",
      type: "multi",
      required: true,
      options: members.options,
    },
    {
      name: "hours",
      label: "Начальные часы каждому исполнителю",
      type: "number",
      min: 0,
      required: true,
    },
    ...Object.entries(criteriaLabels).map(([name, label]) => ({
      name,
      label,
      type: "select" as const,
      value: "false",
      options: [
        { value: "false", label: "Нет" },
        { value: "true", label: "Да" },
      ],
    })),
  ];
  return (
    <Card title="Новая задача">
      <QueryState loading={members.loading} error={members.error}>
        <ActionForm
          fields={fields}
          submitLabel="Создать задачу"
          externalState={parentId}
          savedExternalState={parentTaskId ?? ""}
          onSubmit={async (v) => {
            const deadline = toUtc(text(v, "deadline"));
            const seasonId = context.data?.season ?? text(v, "season");
            const season = seasons.data?.items.find(
              (x) => x.season_id === seasonId,
            );
            if (
              !season ||
              !(
                scope.kind === "block" ? ["open"] : ["open", "planned"]
              ).includes(season.state)
            )
              throw Error("В этом состоянии сезона новые задачи недоступны");
            if (parentId && !parents.some(candidate => candidate.task_id === parentId)) throw Error("Выберите доступную родительскую задачу этого сезона");
            await perform(async () => {
              const created = await tasksApi.create({
                season_id: seasonId,
                scope,
                queue_id: text(v, "queue"),
                parent_task_id: parentId || null,
                title: text(v, "title"),
                description: richText(text(v, "description")),
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
                assignees: ids(v, "users").map((user_id) => ({
                  user_id,
                  hours: number(v, "hours"),
                })),
              });
              navigate(getTaskRoute(created.task_id));
            });
          }}
        >
          <label className={s.parentField}>Поиск родительской задачи<input type="search" value={parentSearch} onChange={event => setParentSearch(event.target.value)} placeholder="Название или ключ задачи" disabled={!seasonId} /></label>
          <QueryState loading={parentCandidates.isLoading && !!seasonId} error={parentCandidates.error} keepDataOnError={!!parentCandidates.data} retry={() => { void parentCandidates.refetch(); }}>
            <label className={s.parentField}>Родительская задача<select name="parent_task_id" value={parentId} disabled={!seasonId} onChange={event => setParentId(event.target.value)}><option value="">Без родительской задачи</option>{parents.map(candidate => <option key={candidate.task_id} value={candidate.task_id}>{candidate.task_key ?? "Задача"} · {candidate.title}{candidate.queue ? ` · ${candidate.queue.name}` : ""}</option>)}</select></label>
            {!seasonId && <p className={w.muted}>Выберите сезон для поиска родительской задачи.</p>}
            {!!seasonId && parentCandidates.data && (parentCandidates.data.next_cursor || (parentCandidates.data.total ?? 0) > parentCandidates.data.items.length) && <p className={w.muted}>Загружено задач: {parentCandidates.data.items.length}{parentCandidates.data.total !== undefined ? ` из ${parentCandidates.data.total}` : ""}. Уточните поиск, чтобы найти другую задачу.</p>}
          </QueryState>
        </ActionForm>
      </QueryState>
    </Card>
  );
}
