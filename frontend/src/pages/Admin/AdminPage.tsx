import { useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import styles from "./Admin.module.css";
import { Icon } from "../../components/Icon";
import { BlocksManagement } from "./panels/BlocksManagement";
import { useMe } from "../../utils/me";

export const AdminPanel = () => {
  const [activeTab, setActiveTab] = useState<"users" | "events" | "blocks">("blocks");
  const navigate = useNavigate();
  const user = useMe();

  const renderContent = () => {
    switch (activeTab) {
      case "blocks":
        return <BlocksManagement />;
      case "users":
        return <div>Компонент управления активистами (скоро будет)</div>;
      case "events":
        return <div>Компонент управления мероприятиями (скоро будет)</div>;
      default:
        return null;
    }
  };

  return (
    <div className={styles.layout}>
      {/* SIDEBAR */}
      <aside className={styles.sidebar}>
        <button className={styles.backButton} onClick={() => navigate(-1)}>
          <Icon name="arrow_back" size={20} />
          Назад
        </button>

        <nav className={styles.nav}>
          <button
            className={clsx(styles.menuItem, activeTab === "users" && styles.menuItemActive)}
            onClick={() => setActiveTab("users")}
          >
            Активисты
          </button>
          <button
            className={clsx(styles.menuItem, activeTab === "blocks" && styles.menuItemActive)}
            onClick={() => setActiveTab("blocks")}
          >
            Блоки
          </button>
          <button
            className={clsx(styles.menuItem, activeTab === "events" && styles.menuItemActive)}
            onClick={() => setActiveTab("events")}
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
              {activeTab === "blocks" ? "Управление блоками" : "База"}
            </h1>
          </div>

          <div className={styles.headerRight}>
            <button className={styles.profileButton}>
              <img
                src={user?.photo_url || `https://placehold.co/100x100/F0A1D8/4A003E?text=${user?.name?.[0] || ""}${user?.surname?.[0] || ""}`}
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