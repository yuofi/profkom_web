import { useQuery } from "@tanstack/react-query";
import type { ScopeRef } from "../../utils/api/contract";
import { membershipApi } from "../../utils/api/membership.api";
import { eventsApi } from "../../utils/api/events.api";
import { usePeopleOptions } from "../../utils/hooks/useWorkspace";
export function useScopeMembers(scope: ScopeRef) {
  const people = usePeopleOptions();
  const source = useQuery({
    queryKey: ["scopeMembers", scope.kind, scope.id],
    queryFn: async () => {
      if (scope.kind === "block") {
        const block = await membershipApi.block(scope.id);
        return [
          ...block.members.map((m) => m.user.user_id),
          block.master?.user.user_id,
          ...(block.master?.deputy_user_ids ?? []),
        ];
      }
      const sub = await eventsApi.subevent(scope.id);
      return [
        ...sub.organizer_user_ids,
        ...sub.leaders.flatMap((l) => [l.user.user_id, ...l.deputy_user_ids]),
      ];
    },
  });
  return {
    loading: source.isLoading || people.isLoading,
    error: source.error ?? people.error,
    options: people.options.filter((p) =>
      source.data?.includes(Number(p.value)),
    ),
  };
}
