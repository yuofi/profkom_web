import { Navigate } from "react-router-dom";
import { useSession } from "../../utils/session";
import { Loading } from "../../components/Workspace/WorkspaceUI";
import { visibleAdminTabs, type AdminTab } from "./adminTabs";

/** An old address of a cabinet tab opens the tab for those who see it, and otherwise the
 * place where the rest find the same thing, not an empty cabinet (GL-31). */
export function LegacyAdminRedirect({ tab, fallback = "/" }: { tab: AdminTab; fallback?: string }) {
  const { session, loading } = useSession();
  if (loading && !session) return <Loading />;
  return <Navigate to={visibleAdminTabs(session).some(item => item.tab === tab) ? `/admin/${tab}` : fallback} replace />;
}
