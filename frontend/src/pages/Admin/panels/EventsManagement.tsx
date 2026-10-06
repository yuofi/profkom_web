import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { contactsApi } from "../../../utils/api/contacts.api";
import styles from "./BlocksManagement.module.css";
import { Button } from "../../../components/Button/Button";
import type { ContactInfoOut, ProfileUpdate } from "../../../utils/api/types";

const EVENT_NAMES = ["Посвят", "Школа Актива", "День математика", "Новый Год", "День Факультета", "Вручение дипломов"];
const ROLE_NAMES = ["главорг", "ответственный", "организатор", "волонтер"];

export const EventsManagement = () => {
  const queryClient = useQueryClient();
  const [editingUser, setEditingUser] = useState<ContactInfoOut | null>(null);
  const [selectedEvent, setSelectedEvent] = useState(EVENT_NAMES[0]);
  const [selectedRole, setSelectedRole] = useState(ROLE_NAMES[0]);

  const { data: contacts, isLoading } = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.getAll,
  });

  const updateMutation = useMutation({
    mutationFn: ({ userId, data }: { userId: number; data: ProfileUpdate }) =>
      contactsApi.update(userId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      setEditingUser(null);
    },
  });

  if (isLoading) return <div>Загрузка пользователей...</div>;

  const users = contacts?.filter((c) => c.in_profcom !== false) || [];

  const handleAddEvent = () => {
    if (!editingUser) return;
    
    let currentEvents: { event: string; role: string }[] = [];
    try {
      currentEvents = JSON.parse(editingUser.events_roles || "[]");
    } catch {
      currentEvents = [];
    }

    // Check if already exists
    const exists = currentEvents.find(e => e.event === selectedEvent);
    if (exists) {
        exists.role = selectedRole;
    } else {
        currentEvents.push({ event: selectedEvent, role: selectedRole });
    }

    updateMutation.mutate({
      userId: editingUser.user_id,
      data: { events_roles: JSON.stringify(currentEvents) }
    });
  };

  const handleRemoveEvent = (user: ContactInfoOut, eventName: string) => {
    let currentEvents: { event: string; role: string }[] = [];
    try {
      currentEvents = JSON.parse(user.events_roles || "[]");
    } catch {
      currentEvents = [];
    }

    currentEvents = currentEvents.filter(e => e.event !== eventName);
    updateMutation.mutate({
      userId: user.user_id,
      data: { events_roles: JSON.stringify(currentEvents) }
    });
  };

  const renderUserEvents = (user: ContactInfoOut) => {
    let currentEvents: { event: string; role: string }[] = [];
    try {
      currentEvents = JSON.parse(user.events_roles || "[]");
    } catch {
      currentEvents = [];
    }

    if (currentEvents.length === 0) return <span>-</span>;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        {currentEvents.map((e, idx) => (
          <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface-container-high)", padding: "4px 8px", borderRadius: "8px" }}>
            <span style={{ fontSize: "14px" }}><b>{e.event}</b> — {e.role}</span>
            <button 
                onClick={() => handleRemoveEvent(user, e.event)}
                style={{ background: "transparent", border: "none", color: "var(--error)", cursor: "pointer", padding: "0 4px" }}
            >
                ✕
            </button>
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <section className={styles.filtersSection}>
        <div className={styles.filtersHeader}>
          <h2 className={styles.filtersTitle}>Управление мероприятиями пользователей</h2>
        </div>
      </section>

      {editingUser && (
        <section className={styles.filtersSection} style={{ background: "var(--surface-container)", padding: "16px", borderRadius: "12px", marginBottom: "16px" }}>
            <h3>Добавление роли для {editingUser.name} {editingUser.surname}</h3>
            <div style={{ display: "flex", gap: "12px", marginTop: "12px" }}>
                <select 
                    value={selectedEvent} 
                    onChange={e => setSelectedEvent(e.target.value)}
                    style={{ padding: "8px", borderRadius: "8px", background: "var(--surface)", color: "var(--on-surface)", border: "1px solid var(--outline)" }}
                >
                    {EVENT_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
                
                <select 
                    value={selectedRole} 
                    onChange={e => setSelectedRole(e.target.value)}
                    style={{ padding: "8px", borderRadius: "8px", background: "var(--surface)", color: "var(--on-surface)", border: "1px solid var(--outline)" }}
                >
                    {ROLE_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
                </select>

                <Button variant="primary" onClick={handleAddEvent} disabled={updateMutation.isPending}>
                    Добавить
                </Button>
                <Button variant="secondary" onClick={() => setEditingUser(null)}>
                    Отмена
                </Button>
            </div>
        </section>
      )}

      <section className={styles.tableContainer}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>ФИО</th>
                <th>Мероприятия</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td colSpan={3} className={styles.tdCenter}>Нет пользователей</td>
                </tr>
              )}
              {users.map((user) => (
                <tr key={user.user_id}>
                  <td className={styles.tdPrimary}>
                    {user.surname} {user.name}
                  </td>
                  <td className={styles.tdSecondary}>
                    {renderUserEvents(user)}
                  </td>
                  <td>
                    <div className={styles.actionsContainer}>
                      <Button 
                        variant="secondary" 
                        onClick={() => {
                            setEditingUser(user);
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        Добавить роль
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};
