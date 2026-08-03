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
import { VKAuthButton } from "../../components/VKAuth/authButton";
import { type AuthError, type TokenResult } from "@vkid/sdk";
import { logger } from "../../utils/logger";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { useQueryClient } from "@tanstack/react-query";

export const GreetingPage = () => {
  const [signUp, setSignUp] = useState(true);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
          logger.log("Данные формы:", formData);
          const response = await authApi.register({
            email: formData.email,
            password: formData.password,
            name: formData.name,
            surname: formData.surname,
            patronymic: formData.patronymic,
            group_number: Number(formData.groupNumber),
            tg: formData.telegram,
          });
          logger.log("Успешная регистрация:", response);
          Cookies.set("access_token", response.data.access_token, {
            expires: 1 / 8,
          });
          logger.log("Успешный вход:", response);
          const meResponse = await authApi.getMe();
          queryClient.setQueryData(["currentUser"], meResponse);
          queryClient.removeQueries({
            predicate: (query) => query.queryKey[0] !== "currentUser",
          });
          navigate("/", { replace: true });
        } else {
          const response = await authApi.login({
            email: data.email,
            password: data.password,
          });
          Cookies.set("access_token", response.data.access_token, {
            expires: 1 / 8,
          });
          logger.log("Успешный вход:", response);
          const meResponse = await authApi.getMe();
          queryClient.setQueryData(["currentUser"], meResponse);
          queryClient.removeQueries({
            predicate: (query) => query.queryKey[0] !== "currentUser",
          });
          navigate("/", { replace: true });
        }
      } catch (error) {
        console.error("Ошибка при отправке:", error);
        throw error;
      }
    },
  });

  const handleLoginSuccess = async (data: TokenResult) => {
    try {
      logger.log("Успешная авторизация VK:", data);
      const response = await authApi.vkLogin({
        access_token: data.access_token,
        id_token: data.id_token,
      });
      Cookies.set("access_token", response.data.access_token, {
        expires: 1 / 8,
      });
      logger.log("Успешный вход через VK:", response);
      const meResponse = await authApi.getMe();
      queryClient.setQueryData(["currentUser"], meResponse);
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== "currentUser",
      });
      navigate("/", { replace: true });
    } catch (error) {
      console.error("Ошибка при VK авторизации на бэкенде:", error);
    }
  };

  const handleLoginError = (error: AuthError) => {
    console.error("Ошибка авторизации:", error);
  };

  return (
    <div className={styles.container}>
      <Helmet>
        <title>
          {signUp ? "Регистрация | Профком ВМК" : "Вход | Профком ВМК"}
        </title>
      </Helmet>
      <CurvedRectangle
        theme="dark"
        cutoutPosition="bottom-right"
        className={styles.card}
      >
        <div className={styles.innerContent}>
          <div className={styles.logo}>
            <ProfkomLogo variant="desktop" width={70} strokeWidth={15} />
          </div>

          <h1 className={styles.headerText}>
            Добро
            <br />
            пожаловать!
          </h1>

          <h1 className={styles.accentHeaderText}>В Профком ВМК</h1>

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
            {signUp ? (
              <VKAuthButton
                onSuccess={handleLoginSuccess}
                onError={handleLoginError}
              />
            ) : (
              <>
                <FormTextField name="email" label="email" type="email" />

                <FormTextField
                  name="password"
                  label="пароль"
                  type="password"
                  isPassword
                />

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
              </>
            )}
            <h5
              className={styles.formSubheading}
              onClick={() => {
                setSignUp(!signUp);
                formik.resetForm();
              }}
            >
              {signUp ? "или войти c паролем" : "войти с вк"}
            </h5>
            {isSuccess && <div>Успешно!</div>}
            {globalError && <div style={{ color: "red" }}>{globalError}</div>}
          </form>
        </FormikProvider>
      </CurvedRectangle>
    </div>
  );
};
