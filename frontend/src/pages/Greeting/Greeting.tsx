import { CurvedRectangle } from "../../components/CurvedRectangle/CurvedRectangle";
import { useForm } from "../../components/Form/Form";
import ProfkomLogo from "../../components/profkomLogo";
import styles from "./Greeting.module.css";
import { SignInValidationSchema } from "../../utils/zod";
import { FormikProvider } from "formik";
import { FormTextField } from "../../components/Form/FormTextFiled";
import { Button } from "../../components/Button/Button";
import { useState } from "react";
import { authApi } from "../../utils/api/auth.api";
import { VKAuthButton } from "../../components/VKAuth/authButton";
import { type TokenResult } from "@vkid/sdk";
import { completeAuthentication } from "../../utils/authSession";
import { normalizeApiError } from "../../utils/api/request";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { useQueryClient } from "@tanstack/react-query";

export const GreetingPage = () => {
  const [signUp, setSignUp] = useState(true);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const gradientClipPath =
    "M0.5 344.087V0.5H294.828C345.087 35.9281 365.664 60.4296 398.609 106.688L400.5 438.5H158.273C119.065 370.449 83.4742 347.686 0.5 344.087Z";

  // A new account signs up with VK and fills its application after; the form only logs in.
  const { formik, isSuccess, globalError, setGlobalError } = useForm({
    initialValues: { email: "", password: "" },
    validationSchema: SignInValidationSchema,
    onSubmit: async (data) => {
      const response = await authApi.login({ email: data.email, password: data.password });
      await completeAuthentication(queryClient, response.data.access_token);
      navigate("/", { replace: true });
    },
  });

  const handleLoginSuccess = async (data: TokenResult) => {
    setGlobalError(null);
    try {
      const response = await authApi.vkLogin({
        access_token: data.access_token, id_token: data.id_token,
      });
      await completeAuthentication(queryClient, response.data.access_token);
      navigate("/", { replace: true });
    } catch (error) {
      setGlobalError(normalizeApiError(error).message);
    }
  };
  const handleLoginError = () => {
    setGlobalError("Не удалось войти через VK. Повторите попытку.");
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
                  {formik.isSubmitting ? "Отправка..." : "Войти"}
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
            {globalError && <div role="alert" style={{ color: "var(--error)" }}>{globalError}</div>}
          </form>
        </FormikProvider>
      </CurvedRectangle>
    </div>
  );
};
