import { useQuery } from "@tanstack/react-query";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text } from "../../components/Workspace/formValues";
import { Empty, QueryState } from "../../components/Workspace/WorkspaceUI";
import type { Task } from "../../utils/api/contract";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { useTaskFormCommand } from "./taskCommands";

/** One command assigns the first season and, when requested, closes the task atomically. */
export function TaskInitialSeasonEditor({ task, closeTask = false, onSaved, onSending }: {
  task: Task; closeTask?: boolean; onSaved: (saved: Task) => void; onSending?: () => void;
}) {
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const run = useTaskFormCommand(task.task_id, onSending), { refresh } = useWorkspaceActions();
  const choices = (seasons.data?.items ?? []).filter(season => season.state !== "closed");
  return <>
    <p>{closeTask ? "Перед закрытием укажите, к какому сезону относится задача. Сезон и статус сохранятся вместе." : "Укажите сезон, в котором будет учитываться работа по этой задаче."}</p>
    <QueryState loading={seasons.isLoading} error={seasons.error} retry={() => void seasons.refetch()}>
      {choices.length ? <ActionForm revision={task.revision} record={`task:${task.task_id}`} allowExitSave={false} submitLabel={closeTask ? "Указать сезон и закрыть" : "Указать сезон"} onConflict={refresh}
        fields={[{ name: "season_id", label: "Сезон задачи", type: "select", value: "", required: true, options: choices.map(season => ({ value: season.season_id, label: season.title })) }]}
        onSubmit={async (values, revision) => {
          const seasonId = text(values, "season_id");
          if (!choices.some(season => season.season_id === seasonId)) throw Error("Выберите незакрытый сезон");
          const saved = await run(revision!, expected => closeTask ? tasksApi.changeStatus(task.task_id, { expected_revision: expected, status: "closed", season_id: seasonId }) : tasksApi.update(task.task_id, { expected_revision: expected, season_id: seasonId }));
          onSaved(saved);return saved;
        }} /> : <Empty>Нет незакрытых сезонов. Попросите председателя или заместителя создать сезон; задача останется открытой.</Empty>}
    </QueryState>
  </>;
}
