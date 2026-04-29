import { useState } from "react";
import styles from "./Admin.module.css";
import { Button } from "../../components/Button/Button";
import { Icon } from "../../components/Icon";
import { BlocksManagement } from "./panels/BlocksManagement";
// import { Icon } from "../Icon"; // Ваши иконки



export const AdminPanel = () => {
  const [activeTab, setActiveTab] = useState<"users" | "events" | "blocks">("blocks");

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
        <div className={styles.logo}>
          <div className={styles.logoIcon}>S</div>
          <div>
            <div>superadmin</div>
            <div style={{ fontSize: "12px", color: "#a0a0a0" }}>panel</div>
          </div>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "24px" }}>
            <Button variant="transparent"
             onClick={() => setActiveTab("users")}>
               <Icon name="account_circle" filled={true}size={20}/>
               Активисты 
            </Button>
            <Button variant="transparent"
             onClick={() => setActiveTab("blocks")}
            >
                <Icon name="deployed_code" filled={true}size={20}/>
                Блоки
            </Button>
            <Button variant="transparent"
             onClick={() => setActiveTab("events")}>
                <Icon name="event" filled={true}size={20}/>
                Мероприятия
            </Button>
        </nav>
      </aside>

      {/* MAIN CONTENT */}
      <main className={styles.contentWrapper}>
        {/* Верхняя панель (Header) */}
        <header className={styles.header}>
          <h1 className={styles.pageTitle}>
            {activeTab === "blocks" ? "Управление блоками" : "База"}
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ textAlign: "right" }}>
              <div>Юлов Павел</div>
              <div style={{ fontSize: "12px", color: "#a0a0a0" }}>superuser</div>
            </div>
            {/* Круглая аватарка пользователя */}
            <div style={{ width: "40px", height: "40px", borderRadius: "50%", backgroundColor: "#fbcfe8" }} />
          </div>
        </header>

        {/* Динамическая область, куда рендерится выбранный компонент */}
        {renderContent()}
      </main>
      
    </div>
  );
};