import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { useMe } from "../../utils/me";
import { authApi } from "../../utils/api/auth.api";
import { contactsApi } from "../../utils/api/contacts.api";
import { FormTextField } from "../../components/Form/FormTextFiled";
import { useForm } from "../../components/Form/Form";
import { FormikProvider } from "formik";
import { Button } from "../../components/Button/Button";
import { Icon } from "../../components/Icon";
import { Avatar } from "../../components/Avatar/Avatar";
import { ProfileValidationSchema, ChangePasswordValidationSchema } from "../../utils/zod";
import styles from "./ProfileEditPage.module.css";
import type { ProfileUpdate } from "../../utils/api/types";
import { useSession } from "../../utils/session";
import { visibleAdminTabs } from "../Admin/adminTabs";
import { Helmet } from "react-helmet-async";

export const ProfileEditPage = () => {
  const user = useMe();
  const { session } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const hasPassword = user?.has_password ?? true;

  const updateMutation = useMutation({
    mutationFn: (data: ProfileUpdate) => contactsApi.update(user!.user_id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["currentUser"] });
      queryClient.invalidateQueries({ queryKey: ["contacts"] });

    },

  });

  const { formik: profileFormik, globalError: profileError } = useForm({
    errorTexts: { 409: "Эта почта уже зарегистрирована." },
    initialValues: {
      surname: user?.surname || "",
      name: user?.name || "",
      patronymic: user?.patronymic || "",
      group_number: user?.group_number ? String(user.group_number) : "",
      budget: user?.budget ? "Бюджет" : "Контракт",
      location: user?.location || "",
      phone: user?.phone || "",
      tg: user?.tg || "",
      email: user?.email || "",
      vk: user?.vk || "",
      photo_url: user?.photo_url || ""
    },
    validationSchema: ProfileValidationSchema,
    onSubmit: async (values, actions) => {
      if (!user) return;
      const clean = ProfileValidationSchema.parse(values);
      const updateData: ProfileUpdate = {
        surname: values.surname,
        name: values.name,
        patronymic: clean.patronymic,
        // Empty keeps the stored group: a legacy non-numeric one is shown as empty.
        group_number: values.group_number || undefined,
        location: values.location,
        phone: values.phone,
        vk: clean.vk,
        tg: clean.tg,
        email: values.email,
        budget: values.budget === "Бюджет",
      };
      await updateMutation.mutateAsync(updateData);
      actions.resetForm({ values: { ...values, patronymic: clean.patronymic, tg: clean.tg ?? "", vk: clean.vk ?? "" } });
    }
  });

  useEffect(() => {
    if (user && !profileFormik.dirty) {
      profileFormik.setValues({
        surname: user.surname || "",
        name: user.name || "",
        patronymic: user.patronymic || "",
        group_number: user.group_number ? String(user.group_number) : "",
        budget: user.budget ? "Бюджет" : "Контракт",
        location: user.location || "",
        phone: user.phone || "",
        tg: user.tg || "",
        email: user.email || "",
        vk: user.vk || "",
        photo_url: user.photo_url || ""
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const { 
    formik: passwordFormik, 
    globalError: passwordError, 
    isSuccess: passwordSuccess,
    setIsSuccess: setPasswordSuccess
  } = useForm({
    errorTexts: { 400: "Неверный текущий пароль." },
    initialValues: {
      oldPassword: "",
      newPassword: "",
      newPasswordAgain: "",
    },
    validationSchema: ChangePasswordValidationSchema,
    onSubmit: async (values) => {
      if (hasPassword && !values.oldPassword) {
        throw new Error("Заполните старый пароль");
      }
      
      await authApi.changePassword({
        old_password: hasPassword ? values.oldPassword || "" : "",
        new_password: values.newPassword
      });
      setPasswordSuccess(true);
    }
  });

  // Handle closing modal and resetting password form
  const handleClosePasswordModal = () => {
    setIsPasswordModalOpen(false);
    passwordFormik.resetForm();
  };

  if (!user) return null;

  return (
    <div className={styles.container}>
      <Helmet>
        <title>Редактирование профиля | Профком ВМК</title>
      </Helmet>
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <button type="button" className={styles.iconButton} onClick={() => navigate(-1)}>
            <Icon name="arrow_back" size={24} />
          </button>
          <h1>Редактирование профиля</h1>
        </div>
      </header>

      <main className={styles.main}>
        <FormikProvider value={profileFormik}>
          <form className={styles.grid} onSubmit={profileFormik.handleSubmit}>
            {profileError && <p role="alert">{profileError}</p>}
            {updateMutation.isSuccess && !profileFormik.dirty && <p role="status">Профиль успешно обновлён</p>}
            {/* Left Column */}
            <div className={styles.column}>
              {/* Card 1: Basic Info */}
              <section className={styles.card}>
                <div className={styles.basicInfoHeader}>
                  <div className={styles.avatarContainer}>
                    <Avatar 
                      src={user.photo_url} 
                      size={96} 
                      mode="view" 
                    />
                  </div>
                  <div className={styles.basicInfoText}>
                    <h2>{user.name} {user.surname}</h2>
                    <p>Основная информация</p>
                  </div>
                </div>

                <div className={styles.form}>
                  <FormTextField name="surname" label="Фамилия" color="on-surface" />
                  <FormTextField name="name" label="Имя" color="on-surface" />
                  <FormTextField name="patronymic" label="Отчество" color="on-surface" />
                  

                </div>
              </section>

              {/* Card 2: Security */}
              <section className={styles.card}>
                <div className={styles.securityHeader}>
                  <div className={styles.securityIcon}>
                    <Icon name="security" size={24} />
                  </div>
                  <div className={styles.securityText}>
                    <h2>Безопасность</h2>
                    <p>Управление доступом</p>
                  </div>
                </div>
                <button 
                  type="button"
                  className={styles.changePasswordBtn}
                  onClick={() => setIsPasswordModalOpen(true)}
                >
                  Изменить пароль
                </button>

                {visibleAdminTabs(session).length > 0 && (
                  <button 
                    type="button"
                    className={styles.adminBtn}
                    onClick={() => navigate("/admin")}
                  >
                    <Icon name="admin_panel_settings" size={20} />
                    Администрирование
                  </button>
                )}
              </section>
            </div>

            {/* Right Column */}
            <div className={styles.column}>
              {/* Card 3: Education Data */}
              <section className={styles.card}>
                <h2 className={styles.cardTitle}>Данные об обучении</h2>
                <div className={styles.form}>
                  <div className={styles.formGrid}>
                    <FormTextField name="group_number" label="Номер группы" color="on-surface" />
                    <FormTextField name="budget" label="Форма обучения" color="on-surface" />
                  </div>
                  <FormTextField name="location" label="Место жительства" color="on-surface" />
                  

                </div>
              </section>

              {/* Card 4: Contact Data */}
              <section className={styles.card}>
                <h2 className={styles.cardTitle}>Контактные данные</h2>
                <div className={styles.form}>
                  <FormTextField name="phone" label="Телефон" type="tel" color="on-surface" />
                  <FormTextField name="tg" label="Телеграмм" color="on-surface" />
                  <FormTextField name="email" label="Почта" type="email" color="on-surface" />
                  <FormTextField name="vk" label="ВК (ссылка)" color="on-surface" />
                  

                </div>
              </section>
            </div>

            {/* Save FAB */}
            <Button 
              variant="primary"
              type="submit"
              className={styles.saveFab} 
              disabled={profileFormik.isSubmitting}
              title="Сохранить"
            >
              {profileFormik.isSubmitting ? (
                <div className={styles.loader} />
              ) : (
                <Icon name="save" size={24} />
              )}
            </Button>
          </form>
        </FormikProvider>
      </main>

      {/* Password Modal */}
      {isPasswordModalOpen && (
        <div className={styles.modalOverlay}>
          <div className={styles.modalBackdrop} onClick={handleClosePasswordModal} />
          <div className={styles.modalContent}>
            <div className={styles.modalHeader}>
              <h3>Изменение пароля</h3>
              <button type="button" className={styles.closeBtn} onClick={handleClosePasswordModal}>
                <Icon name="close" size={24} />
              </button>
            </div>
            
            <FormikProvider value={passwordFormik}>
              <form className={styles.form} onSubmit={passwordFormik.handleSubmit}>
                {hasPassword && (
                  <FormTextField 
                    name="oldPassword"
                    label="Старый пароль" 
                    type="password"
                    isPassword
                    color="on-surface"
                  />
                )}
                <FormTextField 
                  name="newPassword"
                  label="Новый пароль" 
                  type="password"
                  isPassword
                  color="on-surface"
                />
                <FormTextField 
                  name="newPasswordAgain"
                  label="Новый пароль ещё раз" 
                  type="password"
                  isPassword
                  color="on-surface"
                />
                
                {passwordError && <div style={{ color: "var(--error)", fontSize: "14px" }}>{passwordError}</div>}
                {passwordSuccess && <div style={{ color: "var(--primary)", fontSize: "14px" }}>Пароль успешно {hasPassword ? "изменен" : "установлен"}!</div>}
                
                <div className={styles.modalActions}>
                  <button type="button" className={styles.cancelBtn} onClick={handleClosePasswordModal}>
                    Отмена
                  </button>
                  <Button variant="primary" type="submit" disabled={passwordFormik.isSubmitting}>
                    Сохранить
                  </Button>
                </div>
              </form>
            </FormikProvider>
          </div>
        </div>
      )}
    </div>
  );
};
