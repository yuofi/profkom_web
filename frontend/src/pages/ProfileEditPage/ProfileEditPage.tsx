import { useState, useEffect } from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { useMe } from "../../utils/me";
import { authApi } from "../../utils/api/auth.api";
import { contactsApi } from "../../utils/api/contacts.api";
import { FormTextField } from "../../components/Form/FormTextFiled";
import { useForm } from "../../components/Form/Form";
import { FormikProvider } from "formik";
import { Button } from "../../components/Button/Button";
import { Page, Card, RouteLink } from "../../components/Workspace/WorkspaceUI";
import s from "../../components/Workspace/Workspace.module.css";
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
    <Page
      title="Редактирование профиля"
      description="Ваши данные видят участники Профкома в контактах."
      actions={<RouteLink to="/profile">К профилю</RouteLink>}
    >
      <Helmet>
        <title>Редактирование профиля | Профком ВМК</title>
      </Helmet>
      <FormikProvider value={profileFormik}>
        <form className={styles.form} onSubmit={profileFormik.handleSubmit}>
          <div className={s.columns}>
            <div className={s.stack}>
              <Card title="Основная информация">
                <div className={styles.person}>
                  <Avatar src={user.photo_url} size={64} mode="view" />
                  <p>{user.name} {user.surname}</p>
                </div>
                <div className={styles.fields}>
                  <FormTextField name="surname" label="Фамилия" color="on-surface" />
                  <FormTextField name="name" label="Имя" color="on-surface" />
                  <FormTextField name="patronymic" label="Отчество" color="on-surface" />
                </div>
              </Card>
              <Card title="Безопасность">
                <div className={s.row}>
                  <button type="button" className={s.button} onClick={() => setIsPasswordModalOpen(true)}>
                    {hasPassword ? "Изменить пароль" : "Задать пароль"}
                  </button>
                  {visibleAdminTabs(session).length > 0 && (
                    <RouteLink to="/admin">Администрирование</RouteLink>
                  )}
                </div>
              </Card>
            </div>
            <div className={s.stack}>
              <Card title="Данные об обучении">
                <div className={styles.fields}>
                  <div className={styles.formGrid}>
                    <FormTextField name="group_number" label="Номер группы" color="on-surface" />
                    <FormTextField name="budget" label="Форма обучения" color="on-surface" />
                  </div>
                  <FormTextField name="location" label="Место жительства" color="on-surface" />
                </div>
              </Card>
              <Card title="Контактные данные">
                <div className={styles.fields}>
                  <FormTextField name="phone" label="Телефон" type="tel" color="on-surface" />
                  <FormTextField name="tg" label="Телеграмм" color="on-surface" />
                  <FormTextField name="email" label="Почта" type="email" color="on-surface" />
                  <FormTextField name="vk" label="ВК (ссылка)" color="on-surface" />
                </div>
              </Card>
            </div>
          </div>
          {/* The way to save stays in sight under the fields, and tells what happened. */}
          <div className={styles.saveBar}>
            {profileError ? (
              <p role="alert" className={styles.saveError}>{profileError}</p>
            ) : updateMutation.isSuccess && !profileFormik.dirty ? (
              <p role="status" className={s.success}>Профиль успешно обновлён</p>
            ) : (
              <p className={s.muted}>{profileFormik.dirty ? "Есть несохранённые изменения" : "Изменений нет"}</p>
            )}
            <button type="submit" className={`${s.button} ${s.primary}`} disabled={profileFormik.isSubmitting}>
              {profileFormik.isSubmitting ? "Сохраняем…" : "Сохранить"}
            </button>
          </div>
        </form>
      </FormikProvider>

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
    </Page>
  );
};
