import styles from "./PendingApproval.module.css";
import Cookies from "js-cookie";
import { Button } from "../../components/Button/Button";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";

export const PendingApprovalPage = () => {
  const navigate = useNavigate()
  const handleLogout = () => {
    Cookies.remove("access_token");
    Cookies.remove("refresh_token");
    navigate("/auth", {replace: true})
    // window.location.href = "/auth";
  };

  return (
    <div className={styles.globalWrapper}>
      <Helmet>
        <title>Ожидание подтверждения | Профком ВМК</title>
      </Helmet>
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
