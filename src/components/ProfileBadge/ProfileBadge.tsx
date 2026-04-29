import styles from "./ProfileBadge.module.css";
import { Icon } from "../Icon";
import { Button } from "../Button/Button";
import type { UserOut } from "../../utils/api/types";
import { ProfileChip } from "./ProfileChip";
import VKIcon from "../../assets/vk.svg?react";
import TelegramIcon from "../../assets/telegram.svg?react";
import Cookies from "js-cookie";

interface ProfileBadgeProps {
  user: UserOut | null;
}

function handleLogout() {
  Cookies.remove("access_token");
  Cookies.remove("refresh_token");
  window.location.href = "/auth";
}

export const ProfileBadge = ({ user }: ProfileBadgeProps) => {
  if (!user) {
    return null;
  }
  const [name, surname, patronymic] = user.user_name.split(" ");

  return (
    <div className={styles.card}>
      {/* Аватар */}
      {/* <div className={styles.avatar}>
            </div> */}
      <Icon name="account_circle" size={64} />

      {/* Имя и группа */}
      <div className={styles.info}>
        <h2 className={styles.name}>
          {name} {surname}
          <br />
          {patronymic}
        </h2>
        <p className={styles.group}>
          {user.group_number} сервер не возвращает форму
        </p>
      </div>

      {/* Соцсети и баллы */}
      <div className={styles.creditsRow}>
        <div className={styles.socials}>
          {/* Для соцсетей используем iconBg без текста, чтобы получились квадратики */}
          <ProfileChip
            variant="iconBg"
            customIcon={<VKIcon width={24} height={24} />}
          >
            {" "}
          </ProfileChip>
          <ProfileChip
            variant="iconBg"
            customIcon={<TelegramIcon width={24} height={24} />}
          >
            {" "}
          </ProfileChip>
        </div>
        <ProfileChip variant="primary" iconName="bar_chart">
          {user.kkr_score} ккр
        </ProfileChip>
      </div>

      {/* Полоса-разделитель */}
      <div className={styles.divider} />

      {/* Контакты */}
      <div className={styles.contacts}>
        <ProfileChip variant="iconBg" iconName="call">
          сюда телефон
        </ProfileChip>
        <ProfileChip variant="iconBg" iconName="mail">
          {user.email}
        </ProfileChip>
      </div>

      {/* Кнопка */}
      <div className={styles.action}>
        <Button variant="bordered" disabled={false}>
          <Icon name="edit" size={20} />
          редактировать профиль
        </Button>
      </div>
      <div className={styles.action}>
        <Button
          variant="bordered"
          disabled={false}
          onClick={() => handleLogout()}
        >
          <Icon name="close" size={20} />
          выйти
        </Button>
      </div>
    </div>
  );
};
