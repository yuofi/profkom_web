import { useNavigate, useParams } from "react-router-dom";
import clsx from "clsx";
import styles from "./Admin.module.css";
import { Icon } from "../../components/Icon";
import { BlocksManagement } from "./panels/BlocksManagement";
import { UsersManagement } from "./panels/UsersManagement";
import { GuidesManagement } from "./panels/GuidesManagement";
import { useMe } from "../../utils/me";
import { Helmet } from "react-helmet-async";
import { getAdminTabRoute } from "../../utils/routes";

export const AdminPanel = () => {
  const navigate = useNavigate();
  const user = useMe();
  const activeTab = useParams<{ tab: string }>().tab;

  const renderContent = () => {
    switch (activeTab) {
      case "blocks":
        return <BlocksManagement />;
      case "guides":
        return <GuidesManagement />;
      case "users":
        return <UsersManagement />;
      case "events":
        return <div>Компонент управления мероприятиями (скоро будет)</div>;
      default:
        return null;
    }
  };

  const getPageTitle = () => {
    switch (activeTab) {
      case "blocks":
        return "Управление блоками";
      case "guides":
        return "Управление гайдами";
      case "users":
        return "Активисты";
      case "events":
        return "Мероприятия";
      default:
        return "Админ-панель";
    }
  };

  return (
    <div className={styles.layout}>
      <Helmet>
        <title>Админ-панель | Профком ВМК</title>
      </Helmet>
      {/* SIDEBAR */}
      <aside className={styles.sidebar}>
        <button className={styles.backButton} onClick={() => navigate("/profile")}>
          <Icon name="arrow_back" size={20} />
          Назад
        </button>

        <nav className={styles.nav}>
          <button
            className={clsx(styles.menuItem, activeTab === "users" && styles.menuItemActive)}
            onClick={() => navigate(getAdminTabRoute("users"))}
          >
            Активисты
          </button>
          <button
            className={clsx(styles.menuItem, activeTab === "blocks" && styles.menuItemActive)}
            onClick={() => navigate(getAdminTabRoute("blocks"))}
          >
            Блоки
          </button>
          <button
            className={clsx(styles.menuItem, activeTab === "guides" && styles.menuItemActive)}
            onClick={() => navigate(getAdminTabRoute("guides"))}
          >
            Гайды
          </button>
          <button
            className={clsx(styles.menuItem, activeTab === "events" && styles.menuItemActive)}
            onClick={() => navigate(getAdminTabRoute("events"))}
          >
            Мероприятия
          </button>
        </nav>
      </aside>

      {/* MAIN CONTENT */}
      <main className={styles.contentWrapper}>
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.pageTitle}>
              {getPageTitle()}
            </h1>
          </div>

          <div className={styles.headerRight}>
            <button className={styles.profileButton}>
              <img
                src={user?.photo_url || `https://placehold.co/100x100/ccfae8/4A003E?text=${user?.name?.[0] || ""}${user?.surname?.[0] || ""}`}
                className={styles.profileAvatar}
                alt="Profile"
              />
              <div className={styles.profileInfo}>
                <span className={styles.profileName}>
                  {user?.name ? `${user.name} ${user.surname}` : "Пользователь"}
                </span>
                <span className={styles.profileRole}>{
                  user?.super_user ? "superuser" : "admin"
                  }
                  </span>
              </div>
              <Icon name="expand_more" size={20} style={{ color: '#CAC4D0', marginLeft: '4px' }} />
            </button>
          </div>
        </header>

        <div className={styles.mainContentArea}>
          <div className={styles.mainContentInner}>
            {renderContent()}
          </div>
        </div>
      </main>
    </div>
  );
};

export default AdminPanel;