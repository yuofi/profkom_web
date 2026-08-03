import styles from "./ProfileBadge.module.css";
import { Icon } from "../Icon";
import { Button } from "../Button/Button";
import type { ContactInfoOut, ProfileUpdate } from "../../utils/api/types";
import { ProfileChip } from "./ProfileChip";
import { Avatar } from "../Avatar/Avatar";
import VKIcon from "../../assets/vk.svg?react";
import TelegramIcon from "../../assets/telegram.svg?react";
import Cookies from "js-cookie";
import { useState } from "react";
import { contactsApi } from "../../utils/api/contacts.api";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { ContactChip, type ContactInfo } from "../ContactChip/ContactChip";
import { parseContent, stringifyContent } from "../../utils/parsing";
import { parseProfileUrl } from "../../utils/parsing";
import { logger } from "../../utils/logger";
import { useNavigate } from "react-router-dom";
import { authApi } from "../../utils/api/auth.api";
interface ProfileBadgeProps {
  user: ContactInfoOut | null;
}

const mapUserToInfo = (user: ContactInfoOut): ContactInfo => {
  return {
    surname: user.surname || "",
    name: user.name || "",
    patronymic: user.patronymic || "",
    kkr_name: user.kkr_name || "",
    group: String(user.group_number || ""),
    residence: user.location || "",
    blocks: user.blocks || "",
    phone: user.phone || "",
    vk: user.vk || "",
    tg: user.tg || "",
    email: user.email || "",
    education: user.budget ? "Бюджет" : "Контракт",
    photo_url: user.photo_url || "",
  };
};

export const ProfileBadge = ({ user }: ProfileBadgeProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(() =>
    user ? stringifyContent(mapUserToInfo(user)) : "",
  );
  const navigate = useNavigate();
  const [photoUrl, setPhotoUrl] = useState(user?.photo_url);
  const queryClient = useQueryClient();

  async function handleLogout() {
    try {
      await authApi.logout();
    } catch (e) {
      console.error(e);
    }
    Cookies.remove("access_token");
    queryClient.setQueryData(["currentUser"], null);
    queryClient.removeQueries();
    navigate("/auth", { replace: true });
    // window.location.href = "/auth";
  }

  const updateMutation = useMutation({
    mutationFn: (data: ProfileUpdate) =>
      contactsApi.update(user!.user_id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["currentUser"] });
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      setIsEditing(false);
      alert("Профиль успешно обновлен");
    },
    onError: (error) => {
      console.error("Ошибка при обновлении профиля:", error);
      alert("Не удалось обновить профиль");
    },
  });

  if (!user) {
    return null;
  }

  const { name, surname, patronymic } = user;

  const handlePhotoUpload = async (url: string) => {
    try {
      await contactsApi.update(user.user_id, { photo_url: url });
      // Invalidate both current user and contacts list
      queryClient.invalidateQueries({ queryKey: ["currentUser"] });
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      logger.log("Profile photo updated successfully");
      setPhotoUrl(url);
    } catch (error) {
      console.error("Failed to update profile photo:", error);
    }
  };

  const handleSave = () => {
    const parsed = parseContent(editContent);
    const updateData: ProfileUpdate = {
      surname: parsed.surname,
      name: parsed.name,
      patronymic: parsed.patronymic,
      kkr_name: parsed.kkr_name,
      group_number: parsed.group,
      location: parsed.residence,
      blocks: parsed.blocks,
      phone: parsed.phone,
      vk: parsed.vk,
      tg: parsed.tg,
      email: parsed.email,
      budget: parsed.education === "Бюджет",
      photo_url: parsed.photo_url,
    };

    updateMutation.mutate(updateData);
  };

  return (
    <div className={styles.card}>
      <ContactChip
        initialContent={editContent}
        mode="edit"
        onChange={(newContent) => setEditContent(newContent)} // This would now need a local state if we want to track unsaved changes
        onSave={handleSave}
        isExternalOpen={isEditing}
        onExternalClose={() => setIsEditing(false)}
        hideChip={true}
        disabledFields={["blocks"]}
      />

      {/* Аватар */}
      <Avatar
        src={photoUrl}
        size={140}
        mode={isEditing ? "edit" : "view"}
        onUpload={handlePhotoUpload}
        className={styles.avatarOverride}
      />

      {/* Имя и группа */}
      <div className={styles.info}>
        <h2 className={styles.name}>
          {surname} {name}
          <br />
          {patronymic}
        </h2>
        <p className={styles.group}>
          {user.group_number} {user.budget ? "(Бюджет)" : "(Контракт)"}
        </p>
      </div>

      {/* Соцсети и баллы */}
      <div className={styles.creditsRow}>
        <div className={styles.socials}>
          {user.vk && (
            <a
              href={parseProfileUrl(user.vk, "vk.com")}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "none" }}
            >
              <ProfileChip
                variant="highlighted"
                customIcon={<VKIcon width={24} height={24} />}
              ></ProfileChip>
            </a>
          )}
          {user.tg && (
            <a
              href={parseProfileUrl(user.tg, "t.me")}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "none" }} // чтобы не было стандартного подчеркивания ссылок
            >
              <ProfileChip
                variant="highlighted"
                customIcon={<TelegramIcon width={24} height={24} />}
              ></ProfileChip>
            </a>
          )}
        </div>
        <ProfileChip variant="primary" iconName="bar_chart">
          {user.kkr_score ?? 0} ккр
        </ProfileChip>
      </div>

      {/* Полоса-разделитель */}
      <div className={styles.divider} />

      {/* Контакты */}
      <div className={styles.contacts}>
        {user.phone && (
          <ProfileChip variant="iconBg" label="телефон" iconName="call">
            {user.phone}
          </ProfileChip>
        )}
        <ProfileChip variant="iconBg" label="почта" iconName="mail">
          {user.email}
        </ProfileChip>
        {user.location && (
          <ProfileChip variant="iconBg" label="локация" iconName="location_on">
            {user.location}
          </ProfileChip>
        )}
      </div>
      <div className={styles.actions}>
        <Button
          variant="transparent"
          disabled={false}
          onClick={() => handleLogout()}
        >
          <Icon name="move_item" size={20} />
          выйти
        </Button>
        <Button
          variant="primary"
          disabled={false}
          onClick={() => navigate("/profile/edit")}
        >
          <Icon name="edit" size={20} />
          редактировать
        </Button>
      </div>
    </div>
  );
};
