import styles from "./PendingApproval.module.css";
import Cookies from "js-cookie";
import { Button } from "../../components/Button/Button";

export const PendingApprovalPage = () => {
  const handleLogout = () => {
    Cookies.remove("access_token");
    Cookies.remove("refresh_token");
    window.location.href = "/auth";
  };

  return (
    <div className={styles.globalWrapper}>
      <div className={styles.wrapper}>

      <h1 className={styles.heading}>Ожидание подтверждения</h1>
      <p className={styles.subheading}>
        Подождите одобрения вступления. Ваша заявка находится на рассмотрении.
      </p>
      <div style={{ marginTop: "20px" }}>
        <Button variant="secondary" onClick={handleLogout}>
          Выйти
        </Button>
      </div>
      </div>
    </div>
  );
};
