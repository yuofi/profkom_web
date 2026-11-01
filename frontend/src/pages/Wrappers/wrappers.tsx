import { lazy, Suspense } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useSession, isActiveSession } from '../../utils/session';
import { Loading, ErrorState } from '../../components/Workspace/WorkspaceUI';
import { canRetainData, normalizeApiError } from '../../utils/api/request';
import { useMe } from '../../utils/me';
import { WorkspaceSkeleton } from '../../components/Workspace/WorkspaceLayout';
import s from "./wrappers.module.css";

// Pending, rejected and temporary-password screens are rare: their forms are not part of
// every member's first download (PF-11).
const AccountStatePage = lazy(() => import("../Workspace/SessionPages").then(m => ({ default: m.AccountStatePage })));
const PasswordChangePage = lazy(() => import("../Workspace/SessionPages").then(m => ({ default: m.PasswordChangePage })));

/** The confirmed session stays while a poll fails for a moment: the page and its drafts too. */
function SessionOffline({ retry }: { retry: () => void }) {
  return <p role="status" className={s.offline}>
    Нет связи с сервером. Повторяем проверку…
    <button type="button" onClick={retry}>Повторить</button>
  </p>;
}

export const ProtectedRoute = () => {
  const { session, loading, error, profileError, refresh } = useSession();
  const user = useMe();
  const { pathname, search, hash } = useLocation();
  if (loading) return <WorkspaceSkeleton />;
  // A transient failure of a later poll keeps the confirmed session (GL-02); the end of the
  // session, a refusal or a first check that failed still close the workspace.
  if (error && (!session || !canRetainData(error)))
    return normalizeApiError(error).status === 401
      // An ended or missing session returns here after the login (GL-13); a logout does not.
      ? <Navigate to="/auth" replace state={{ from: pathname + search + hash }} />
      : <ErrorState error={error} retry={refresh} />;
  if (!session) return <Navigate to="/auth" replace />;
  if (session.password_change_required) return <Suspense fallback={<Loading />}><PasswordChangePage /></Suspense>;
  if (!isActiveSession(session)) return <Suspense fallback={<Loading />}><AccountStatePage /></Suspense>;
  // Profile forms take their initial values from this record. Mount them only
  // after it arrives, while other pages can fetch alongside the profile.
  if (!user && (pathname === "/profile" || pathname.startsWith("/profile/")))
    return profileError ? <ErrorState error={profileError} retry={refresh} /> : <Loading />;
  return <>{error ? <SessionOffline retry={refresh} /> : null}<Outlet /></>;
};
