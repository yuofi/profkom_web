import { Navigate, useParams } from "react-router-dom";
import { GuidesManagement } from "./panels/GuidesManagement";
import { Page, RouteLink } from "../../components/Workspace/WorkspaceUI";
import styles from "./Admin.module.css";

/** Keep bookmarked URLs; all domain actions use the current screens and DTOs. */
export const AdminPanel = () => {
  const { tab } = useParams<{ tab: string }>();
  if (tab !== "guides") {
    const destination =
      tab === "users" ? "/registrations" : tab === "blocks" ? "/blocks" : "/events";
    return <Navigate to={destination} replace />;
  }
  return (
    <Page
      title="Управление гайдами"
      actions={<RouteLink to="/materials">Материалы</RouteLink>}
    >
      <div className={styles.nav}>
        <RouteLink to="/registrations">Регистрации</RouteLink>
        <RouteLink to="/blocks">Блоки</RouteLink>
        <RouteLink to="/events">Мероприятия</RouteLink>
      </div>
      <div className={styles.mainContentInner}><GuidesManagement /></div>
    </Page>
  );
};

export default AdminPanel;
