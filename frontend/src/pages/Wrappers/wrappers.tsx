import { Navigate, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useMe } from "../../utils/me";
import { canEditGuide } from "../../utils/filterRoles";
import { guidesApi } from "../../utils/api/guides.api";
import { blocksApi } from "../../utils/api/blocks.api";
import { getDocRoute } from "../../utils/routes";
import { AccountStatePage } from '../Workspace/SessionPages';
import { useSession, isActiveSession, can } from '../../utils/session';
import { Loading, ErrorState } from '../../components/Workspace/WorkspaceUI';
import { normalizeApiError } from '../../utils/api/request';

export const ProtectedRoute = () => {
  const { session, loading, error, refresh } = useSession();
  if (loading) return <Loading />;
  if (error) return normalizeApiError(error).status === 401 ? <Navigate to="/auth" replace /> : <ErrorState error={error} retry={refresh} />;
  if (!session) return <Navigate to="/auth" replace />;
  if (!isActiveSession(session)) return <AccountStatePage />;
  return <Outlet />;
};

export const ExtendedRoute = () => {
  const { session } = useSession();
  return can(session, 'review_registrations') ? <Outlet /> : <Navigate to="/" replace />;
};

export const GuideEditRoute = () => {
  const user = useMe();
  const { id } = useParams<{ id: string }>();

  const { data: guide, isLoading: isGuideLoading, isError } = useQuery({
    queryKey: ["guide", id, user?.user_id ?? "anon"],
    queryFn: () => guidesApi.getById(id!),
    enabled: !!id,
    retry: false,
  });

  const { data: blocks, isLoading: isBlocksLoading } = useQuery({
    queryKey: ["blocks"],
    queryFn: blocksApi.getAll,
    enabled: !!user,
  });

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  if (isGuideLoading || isBlocksLoading) {
    return <div>Загрузка редактора...</div>;
  }

  if (isError || !guide) {
    return <Navigate to="/" replace />;
  }

  if (!canEditGuide(guide, user, blocks)) {
    return <Navigate to={getDocRoute(guide.guide_id)} replace />;
  }

  return <Outlet />;
};
