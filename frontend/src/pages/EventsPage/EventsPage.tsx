import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { contactsApi } from "../../utils/api/contacts.api";
import styles from "./EventsPage.module.css";
import { Helmet } from "react-helmet-async";

const EVENT_NAMES = [
  "Посвят",
  "Школа Актива",
  "День математика",
  "Новый Год",
  "День Факультета",
  "Вручение дипломов"
];

const MOCK_EVENTS = EVENT_NAMES.map((name, i) => ({
  id: `event-${i + 1}`,
  title: name,
  content: `Описание для мероприятия «${name}». Здесь будет детальная информация о времени, месте проведения и программе.`,
}));

export const EventsPage = () => {
  const [activeId, setActiveId] = useState(MOCK_EVENTS[0].id);
  const { data: contacts, isLoading } = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.getAll,
  });

  const activeEvent = MOCK_EVENTS.find(e => e.id === activeId);

  return (
    <div className={styles.container}>
      <Helmet>
        <title>Мероприятия | Профком ВМК</title>
      </Helmet>
      
      <aside className={styles.sidebar}>
        <ul className={styles.navLinks}>
          {MOCK_EVENTS.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => setActiveId(item.id)}
                className={`${styles.navLink} ${item.id === activeId ? styles.active : ""}`}
              >
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <article className={styles.mainContent}>
        {activeEvent && (
          <div>
            <h1 className={styles.pageTitle}>{activeEvent.title}</h1>
            <p className={styles.pageDescription}>{activeEvent.content}</p>

            <div style={{ marginTop: "32px" }}>
              <h2 style={{ fontSize: "20px", marginBottom: "16px", color: "var(--on-surface)" }}>
                Участники
              </h2>
              {(() => {
                if (isLoading) return <div>Загрузка участников...</div>;
                
                const participants: Record<string, any[]> = {};
                
                (contacts || []).forEach(user => {
                  try {
                    const roles = JSON.parse(user.events_roles || "[]");
                    roles.forEach((r: any) => {
                      if (r.event === activeEvent.title) {
                        if (!participants[r.role]) participants[r.role] = [];
                        participants[r.role].push(user);
                      }
                    });
                  } catch (e) {}
                });

                if (Object.keys(participants).length === 0) {
                  return <div style={{ color: "var(--on-surface-variant)" }}>Пока нет участников</div>;
                }

                // Sort roles by importance if possible, or just display them
                return Object.entries(participants).map(([role, users]) => (
                  <div key={role} style={{ marginBottom: "16px" }}>
                    <h3 style={{ fontSize: "16px", color: "var(--primary)", textTransform: "capitalize", marginBottom: "8px" }}>
                      {role}
                    </h3>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                      {(users as any[])?.map(u => (
                        <div key={u.user_id} style={{ 
                          background: "var(--surface-container-high)", 
                          padding: "6px 12px", 
                          borderRadius: "16px",
                          fontSize: "14px",
                          display: "flex",
                          alignItems: "center",
                          gap: "8px"
                        }}>
                          {u.photo_url ? (
                            <img src={u.photo_url} alt="" style={{ width: "24px", height: "24px", borderRadius: "50%", objectFit: "cover" }} />
                          ) : (
                            <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "var(--primary)", color: "var(--on-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px" }}>
                              {u.name?.[0] || ""}{u.surname?.[0] || ""}
                            </div>
                          )}
                          {u.name} {u.surname}
                        </div>
                      ))}
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>
        )}
      </article>
    </div>
  );
};
