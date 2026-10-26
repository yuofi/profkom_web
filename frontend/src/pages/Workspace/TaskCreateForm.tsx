import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, QueryState } from "../../components/Workspace/WorkspaceUI";
import { ActionForm, type Field } from "../../components/Workspace/ActionForm";
import { text, ids, number } from "../../components/Workspace/formValues";
import { useScopeMembers } from "../../components/Workspace/ScopeMembers";
import { tasksApi } from "../../utils/api/tasks.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { membershipApi } from "../../utils/api/membership.api";
import { eventsApi } from "../../utils/api/events.api";
import { richText, emptyCriteria, type ScopeRef } from "../../utils/api/contract";
import { can } from "../../utils/session";
import { toUtc } from "../../utils/dates";
import { getTaskRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
const criteriaLabels = {
  unique: "Уникальная",
  creative: "Творческая",
  external_communication: "Общение вне вуза",
  in_person: "Очное присутствие",
  fixed_time: "В определённое время",
};
export function TaskCreateForm({ scope }: { scope: ScopeRef }) {
  const navigate = useNavigate();
  const { perform } = useWorkspaceActions();
  const members = useScopeMembers(scope);
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
  if (!can(context.data?.source, "create_task")) return null;
  const fields: Field[] = [
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
            await perform(async () => {
              const created = await tasksApi.create({
                season_id: seasonId,
                scope,
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
        />
      </QueryState>
    </Card>
  );
}
