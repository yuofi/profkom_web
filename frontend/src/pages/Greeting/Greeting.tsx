import { CurvedRectangle } from "../../components/CurvedRectangle/CurvedRectangle";
import { useForm } from "../../components/Form/Form";
import ProfkomLogo from "../../components/profkomLogo";
import styles from "./Greeting.module.css";
import {
  SignInValidationSchema,
  SignUpValidationSchema,
} from "../../utils/zod";
import { FormikProvider } from "formik";
import { FormTextField } from "../../components/Form/FormTextFiled";
import { Button } from "../../components/Button/Button";
import { useState } from "react";
import { authApi } from "../../utils/api/auth.api";
import Cookies from "js-cookie";
import type z from "zod";

export const GreetingPage = () => {
  const [signUp, setSignUp] = useState(true);

  const gradientClipPath =
    "M0.5 344.087V0.5H294.828C345.087 35.9281 365.664 60.4296 398.609 106.688L400.5 438.5H158.273C119.065 370.449 83.4742 347.686 0.5 344.087Z";

  const { formik, isSuccess, globalError } = useForm({
    initialValues: (signUp
      ? {
          email: "",
          password: "",
          passwordAgain: "",
          groupNumber: "",
          telegram: "",
          name: "",
          surname: "",
          patronymic: "",
        }
      : { email: "", password: "" }) as z.infer<typeof SignUpValidationSchema> &
      z.infer<typeof SignInValidationSchema>,
    validationSchema: signUp ? SignUpValidationSchema : SignInValidationSchema,
    onSubmit: async (data) => {
      try {
        if (signUp) {
          const formData = data as z.infer<typeof SignUpValidationSchema>;
          console.log("Данные формы:", formData);
          const response = await authApi.register({
            email: formData.email,
            password: formData.password,
            name: formData.name,
            surname: formData.surname,
            patronymic: formData.patronymic,
            group_number: Number(formData.groupNumber),
            tg: formData.telegram,
          });
          console.log("Успешная регистрация:", response);
          Cookies.set("access_token", response.data.access_token, {
            expires: 1 / 8,
          });
          Cookies.set("refresh_token", response.data.refresh_token, {
            expires: 7,
          });
          console.log("Успешный вход:", response);
          window.location.href = "/";
        } else {
          const response = await authApi.login({
            email: data.email,
            password: data.password,
          });
          Cookies.set("access_token", response.data.access_token, {
            expires: 1 / 8,
          });
          Cookies.set("refresh_token", response.data.refresh_token, {
            expires: 7,
          });
          console.log("Успешный вход:", response);
          window.location.href = "/";
        }
      } catch (error) {
        console.error("Ошибка при отправке:", error);
      }
    },
  });

  return (
    <div className={styles.container}>
      <CurvedRectangle
        theme="dark"
        cutoutPosition="bottom-right"
        className={styles.card}
      >
        <div className={styles.innerContent}>
          <div className={styles.logo}>
            <ProfkomLogo variant="desktop" />
          </div>

          <h1 className={styles.headerText}>
            Добро
            <br />
            пожаловать!
          </h1>

          <h1 className={styles.accentHeaderText}>В профком ВМК</h1>

          <div className={styles.dashedBox}>
            Сначала больно, потом приятно <br />© Павел Юлов
          </div>
        </div>
      </CurvedRectangle>

      <CurvedRectangle
        theme="gradient"
        cutoutPosition="bottom-left"
        customPathStr={gradientClipPath}
        customPathWidth={380}
        customPathHeight={419}
        className={styles.card}
      >
        <FormikProvider value={formik}>
          <form className={styles.form} onSubmit={formik.handleSubmit}>
            <div className={styles.formHeader}>
              <h3 className={styles.formHeaderText}>
                {signUp ? "Зарегистрироваться" : "Войти"}
              </h3>

              <h5
                className={styles.formSubheading}
                onClick={() => {
                  setSignUp(!signUp);
                  formik.resetForm();
                }}
              >
                {signUp ? "или войти" : "или создать аккаунт"}
              </h5>
            </div>

            <FormTextField name="email" label="email" type="email" />

            <FormTextField name="password" label="пароль" type="password" />

            {signUp && (
              <>
                <FormTextField
                  name="passwordAgain"
                  label="пароль снова"
                  type="password"
                />

                <FormTextField
                  name="groupNumber"
                  label="номер группы"
                  type="text"
                />

                <FormTextField name="telegram" label="@ник в тг" type="text" />

                <FormTextField name="name" label="Имя" type="text" />

                <FormTextField name="surname" label="Фамилия" type="text" />

                <FormTextField name="patronymic" label="Отчество" type="text" />
              </>
            )}

            <Button
              variant="primary"
              type="submit"
              disabled={formik.isSubmitting}
            >
              {formik.isSubmitting
                ? "Отправка..."
                : signUp
                  ? "Создать аккаунт"
                  : "Войти"}
            </Button>

            {isSuccess && <div>Успешно!</div>}
            {globalError && <div style={{ color: "red" }}>{globalError}</div>}
          </form>
        </FormikProvider>
      </CurvedRectangle>
    </div>
  );
};
