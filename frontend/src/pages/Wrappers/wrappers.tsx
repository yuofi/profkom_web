import { Navigate, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useMe } from "../../utils/me";
import { filterRoles, canEditGuide } from "../../utils/filterRoles";
import { guidesApi } from "../../utils/api/guides.api";
import { blocksApi } from "../../utils/api/blocks.api";
import { getDocRoute } from "../../utils/routes";
import { PendingApprovalPage } from "../fallback/PendingApproval";

export const ProtectedRoute = () => {
  const user = useMe();

  if (!user) {
    return <Navigate to="/auth" replace />;
  }
  
  if (user.in_profcom === false && !user.super_user) {
    return <PendingApprovalPage />;
  }

  return <Outlet />;
};

interface ExtendedRouteProps {
  allowedRoles?: Array<'admin' | 'super_user'>;
}

export const ExtendedRoute = ({ allowedRoles }: ExtendedRouteProps) => {
  const user = useMe();

  if (!user) {
    return <Navigate to="/" replace />;
  }

  if (user.super_user) {
    return <Outlet />;
  }

  if (!filterRoles(allowedRoles, user)) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
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
