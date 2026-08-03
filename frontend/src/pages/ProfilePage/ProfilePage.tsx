import { Button } from "../../components/Button/Button";
import { Icon } from "../../components/Icon";
import { ProfileBadge } from "../../components/ProfileBadge/ProfileBadge";
import { useMe } from "../../utils/me";
import { useNavigate } from "react-router-dom";
import styles from "./ProfilePage.module.css";
import { filterRoles } from "../../utils/filterRoles";
import { Helmet } from "react-helmet-async";


export const ProfilePage = () => {
  const user = useMe();
  const navigate = useNavigate();


  return (
    <div className={styles.mainContainer}>
      <Helmet>
        <title>Профиль | Профком ВМК</title>
      </Helmet>
      <ProfileBadge user={user} />

      {filterRoles(["admin", "super_user"], user) && (
        <Button
          variant="primary"
          disabled={false}
          onClick={() => navigate("/admin")}
        >
          <Icon name="arrow_back" size={20} />
          админская панель
        </Button>
      )}
    </div>
    
  );
}