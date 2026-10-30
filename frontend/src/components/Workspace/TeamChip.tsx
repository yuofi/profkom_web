import { useQuery } from "@tanstack/react-query";
import type { TaskScopeRef } from "../../utils/api/contract";
import { membershipApi } from "../../utils/api/membership.api";
import { eventsApi } from "../../utils/api/events.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { canRetainData } from "../../utils/api/request";
import { getEventRoute, getSubeventRoute, getTaskQueueRoute } from "../../utils/routes";
import { BlockChip } from "./BlockChip";
import { ChipInitials } from "./ChipFace";
import { InteractiveChip } from "./InteractiveChip";
import { eventLogo } from "../../utils/teamLogos";

interface Props { scope: TaskScopeRef; title?: string; avatarUrl?: string | null; interactive?: boolean; className?: string }
const missingTitle = (kind: TaskScopeRef["kind"]) => kind === "block" ? "Блок недоступен" : kind === "subevent" ? "Команда недоступна" : kind === "event" ? "Мероприятие недоступно" : "Очередь недоступна";
/** Supplied readable metadata costs no request; incomplete identities resolve by their real scope. */
export function TeamChip(props: Props) {
  if (props.scope.kind === "chair") return <TeamIdentity {...props} title="Работа председателя" />;
  if (props.title?.trim()) return <TeamIdentity {...props} title={props.title} />;
  if (props.interactive === false) return <InteractiveChip kind="display" label={missingTitle(props.scope.kind)} className={props.className} />;
  return <ResolvedTeamChip {...props} />;
}
function ResolvedTeamChip(props: Props) {
  const { scope } = props;
  const query = useQuery({
    queryKey: scope.kind === "block" ? ["workspaceBlocks", scope.id] : scope.kind === "subevent" ? ["events", "subevent", scope.id] : scope.kind === "event" ? ["events", scope.id] : ["tasks", "queues", scope.id],
    queryFn: async () => {
      if (scope.kind === "block") return membershipApi.block(scope.id);
      if (scope.kind === "subevent") return eventsApi.subevent(scope.id);
      if (scope.kind === "event") return eventsApi.get(scope.id);
      return taskQueuesApi.get(scope.id);
    },
  });
  // Do not project cached identities through a current 403/404.
  if (query.error && !canRetainData(query.error)) return <InteractiveChip kind="display" label={missingTitle(scope.kind)} className={props.className} />;
  if (!query.data) return <InteractiveChip kind="display" label={query.isLoading ? "Загружаем команду…" : missingTitle(scope.kind)} className={props.className} />;
  const title = "name" in query.data ? query.data.name : query.data.title;
  return <TeamIdentity {...props} title={title} avatarUrl={"avatar_url" in query.data ? query.data.avatar_url : null} />;
}
function TeamIdentity({ scope, title, avatarUrl, interactive = true, className }: Props & { title: string }) {
  if (scope.kind === "block") return <BlockChip block={{ block_id: scope.id, name: title, avatar_url: avatarUrl }} interactive={interactive} className={className} />;
  const face = { label: title, avatarUrl: avatarUrl ?? (scope.kind === "event" ? eventLogo(title) : null), avatarFallback: <ChipInitials name={title} />, className };
  const to = scope.kind === "event" ? getEventRoute(scope.id) : scope.kind === "chair" ? "/tasks?scope_kind=chair&scope_id=chair" : scope.kind === "subevent" ? getSubeventRoute(scope.id) : getTaskQueueRoute(scope.id);
  return interactive ? <InteractiveChip kind="link" to={to} {...face} /> : <InteractiveChip kind="display" {...face} />;
}
