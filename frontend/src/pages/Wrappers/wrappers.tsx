import { Navigate, Outlet, useLocation } from "react-router-dom";
import { AccountStatePage, PasswordChangePage } from '../Workspace/SessionPages';
import { useSession, isActiveSession } from '../../utils/session';
import { Loading, ErrorState } from '../../components/Workspace/WorkspaceUI';
import { normalizeApiError } from '../../utils/api/request';
import { useMe } from '../../utils/me';

export const ProtectedRoute = () => {
  const { session, loading, error, refresh } = useSession();
  const user = useMe();
  const { pathname } = useLocation();
  if (loading) return <Loading />;
  if (error) return normalizeApiError(error).status === 401 ? <Navigate to="/auth" replace /> : <ErrorState error={error} retry={refresh} />;
  if (!session) return <Navigate to="/auth" replace />;
  if (session.password_change_required) return <PasswordChangePage />;
  if (!isActiveSession(session)) return <AccountStatePage />;
  // Profile forms take their initial values from this record. Mount them only
  // after it arrives, while other pages can fetch alongside the profile.
  if (!user && (pathname === "/profile" || pathname.startsWith("/profile/"))) return <Loading />;
  return <Outlet />;
};
