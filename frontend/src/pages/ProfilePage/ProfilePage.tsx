import { Button } from "../../components/Button/Button";
import { Icon } from "../../components/Icon";
import { ProfileBadge } from "../../components/ProfileBadge/ProfileBadge";
import { TextField } from "../../components/TextField/TextField";
import { useMe } from "../../utils/me";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { authApi } from "../../utils/api/auth.api";
import { tryCatch } from "../../utils/tryCatch";
import styles from "./ProfilePage.module.css";


export const ProfilePage = () => {
  const user = useMe();
  const navigate = useNavigate();

  const hasPassword = user?.has_password ?? true;

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const handleChangePassword = async () => {
    setPasswordError("");
    setPasswordSuccess(false);
    
    if (hasPassword && !oldPassword) {
      setPasswordError("Заполните старый пароль");
      return;
    }
    if (!newPassword || (hasPassword && !oldPassword)) {
      setPasswordError("Заполните оба поля");
      return;
    }

    const { error } = await tryCatch(authApi.changePassword({
      old_password: hasPassword ? oldPassword : "",
      new_password: newPassword
    }));
    
    if (error) {
      setPasswordError("Ошибка при смене пароля. Возможно, старый пароль неверен.");
    } else {
      setPasswordSuccess(true);
      setOldPassword("");
      setNewPassword("");
      // Force reload to update user context (has_password will become true)
      setTimeout(() => window.location.reload(), 1500);
    }
  };

  return (
    <div className={styles.mainContainer}>
      <ProfileBadge user={user} />
      
      <div className={styles.passwordSection}>
        <h3>{hasPassword ? "Смена пароля" : "Установка пароля"}</h3>
        {hasPassword && (
          <TextField 
            label="Старый пароль" 
            type="password" 
            value={oldPassword} 
            onChange={(e) => setOldPassword(e.target.value)} 
            error={!!passwordError}
          />
        )}
        <TextField 
          label="Новый пароль" 
          type="password" 
          value={newPassword} 
          onChange={(e) => setNewPassword(e.target.value)} 
          error={!!passwordError}
          supportingText={passwordError || (passwordSuccess ? (hasPassword ? "Пароль успешно изменен!" : "Пароль успешно установлен!") : undefined)}
        />
        <Button variant="primary" onClick={handleChangePassword}>
          {hasPassword ? "Сменить пароль" : "Установить пароль"}
        </Button>
      </div>

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