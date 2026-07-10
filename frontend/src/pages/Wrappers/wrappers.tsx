import { Navigate, Outlet } from "react-router-dom";
import { useMe } from "../../utils/me";

export const ProtectedRoute = () => {
  const user = useMe();

  if (!user) {
    return <Navigate to="/auth" replace />;
  }
  return <Outlet />;
};

export const AuthRoute = () => {
    const user = useMe();

    if (user) {
        return <Navigate to="/" replace />;
    }
    return <Outlet />;
};

export const AdminRoute = () => {
  const user = useMe();
  
  if (!user || !user.admin) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
};