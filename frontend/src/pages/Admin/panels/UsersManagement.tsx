import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { contactsApi } from "../../../utils/api/contacts.api";
import styles from "./BlocksManagement.module.css";
import { Button } from "../../../components/Button/Button";
import type { ContactInfoOut } from "../../../utils/api/types";

export const UsersManagement = () => {
  const queryClient = useQueryClient();

  const { data: contacts, isLoading } = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.getAll,
  });

  const updateMutation = useMutation({
    mutationFn: ({ userId, data }: { userId: number; data: Partial<ContactInfoOut> }) =>
      contactsApi.update(userId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
    },
  });

  if (isLoading) return <div>Загрузка заявок...</div>;

  const pendingUsers = contacts?.filter((c) => c.in_profcom === false) || [];

  return (
    <>
      <section className={styles.filtersSection}>
        <div className={styles.filtersHeader}>
          <h2 className={styles.filtersTitle}>Заявки на вступление</h2>
        </div>
      </section>

      <section className={styles.tableContainer}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>ФИО</th>
                <th>Группа</th>
                <th>ВК</th>
                <th>ТГ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pendingUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className={styles.tdCenter}>Нет новых заявок</td>
                </tr>
              )}
              {pendingUsers.map((user) => (
                <tr key={user.user_id}>
                  <td className={styles.tdPrimary}>
                    {user.surname} {user.name} {user.patronymic}
                  </td>
                  <td className={styles.tdSecondary}>{user.group_number}</td>
                  <td className={styles.tdSecondary}>{user.vk || "-"}</td>
                  <td className={styles.tdSecondary}>{user.tg || "-"}</td>
                  <td>
                    <div className={styles.actionsContainer}>
                      <Button 
                        variant="tertiary" 
                        onClick={() => updateMutation.mutate({ userId: user.user_id, data: { in_profcom: true } })}
                        disabled={updateMutation.isPending}
                      >
                        Одобрить
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
