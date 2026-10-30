import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ProfileBadge } from "../../components/ProfileBadge/ProfileBadge";
import { Card, Empty, Page, QueryState, RouteLink } from "../../components/Workspace/WorkspaceUI";
import { directoryApi } from "../../utils/api/directory.api";
import { useSession } from "../../utils/session";
import w from "../../components/Workspace/Workspace.module.css";
import { ProfileActivity } from "../../components/Workspace/ProfileActivity";
import { ProfileAchievements } from "../../components/Workspace/ProfileAchievements";
import { ProfileTeams } from "../../components/Workspace/ProfileTeams";

/** The same authorized directory projection, now with a bookmarkable participant URL. */
export function MemberProfilePage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const query = useQuery({ queryKey: ["contacts"], queryFn: directoryApi.contacts });
  const person = query.data?.find((item) => String(item.user_id) === id && item.in_profcom);
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
