import { Navigate, Outlet } from "react-router-dom";
import { AccountStatePage, PasswordChangePage } from '../Workspace/SessionPages';
import { useSession, isActiveSession } from '../../utils/session';
import { Loading, ErrorState } from '../../components/Workspace/WorkspaceUI';
import { normalizeApiError } from '../../utils/api/request';

export const ProtectedRoute = () => {
  const { session, loading, error, refresh } = useSession();
  if (loading) return <Loading />;
  if (error) return normalizeApiError(error).status === 401 ? <Navigate to="/auth" replace /> : <ErrorState error={error} retry={refresh} />;
  if (!session) return <Navigate to="/auth" replace />;
  if (session.password_change_required) return <PasswordChangePage />;
  if (!isActiveSession(session)) return <AccountStatePage />;
  return <Outlet />;
};
