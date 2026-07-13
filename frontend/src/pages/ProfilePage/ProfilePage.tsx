import { Button } from "../../components/Button/Button";
import { Icon } from "../../components/Icon";
import { ProfileBadge } from "../../components/ProfileBadge/ProfileBadge";
import { useMe } from "../../utils/me";
import { useNavigate } from "react-router-dom";
import styles from "./ProfilePage.module.css";


export const ProfilePage = () => {
  const user = useMe();
  const navigate = useNavigate();
  return (
    <div className={styles.mainContainer}>
      <ProfileBadge user={user} />
        {user?.admin && (
        <Button
          variant="secondary"
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