import { Navigate, Outlet } from "react-router-dom";
import { useMe } from "../../utils/me";
import { filterRoles } from "../../utils/filterRoles";
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