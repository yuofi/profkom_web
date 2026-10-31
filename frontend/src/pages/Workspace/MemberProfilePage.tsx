import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ProfileBadge } from "../../components/ProfileBadge/ProfileBadge";
import { Card, Empty, Page, QueryState, RouteLink } from "../../components/Workspace/WorkspaceUI";
import { directoryApi } from "../../utils/api/directory.api";
import type { ContactInfoOut } from "../../utils/api/types";
import { useSession } from "../../utils/session";
import w from "../../components/Workspace/Workspace.module.css";
import { ProfileActivity } from "../../components/Workspace/ProfileActivity";
import { ProfileAchievements } from "../../components/Workspace/ProfileAchievements";
import { ProfileTeams } from "../../components/Workspace/ProfileTeams";

/** The same authorized directory projection, now with a bookmarkable participant URL. */
export function MemberProfilePage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const client = useQueryClient();
  const userId = /^[1-9][0-9]*$/.test(id) ? Number(id) : null;
  // One directory entry instead of the whole directory (PF-15); a loaded directory shows it at once.
  const query = useQuery({
    queryKey: ["contacts", "one", userId],
    queryFn: () => directoryApi.contact(userId!),
    enabled: userId !== null,
    initialData: () => { const listed = client.getQueryData<ContactInfoOut[]>(["contacts"])?.filter((item) => item.user_id === userId);return listed?.length ? listed : undefined; },
    initialDataUpdatedAt: () => client.getQueryState(["contacts"])?.dataUpdatedAt,
  });
  const person = query.data?.find((item) => item.user_id === userId && item.in_profcom);
  return <Page title="Профиль участника" actions={<RouteLink to="/contacts">Все контакты</RouteLink>}>
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data} retry={() => void query.refetch()}>
      <div className={w.stack}>
      {person ? <div className={w.columns}>
        <ProfileBadge key={person.user_id} user={person} readOnly />
        <div className={w.stack}>
          {session?.user_id === person.user_id && <Card title="Мой профиль"><RouteLink to="/profile">Управление своим профилем</RouteLink></Card>}
          <ProfileTeams userId={person.user_id} />
        </div>
      </div> : <Empty>Профиль участника недоступен в текущем справочнике.</Empty>}
      {person && <><ProfileAchievements userId={person.user_id} /><ProfileActivity userId={person.user_id} hideCurrent /></>}
      </div>
    </QueryState>
  </Page>;
}
