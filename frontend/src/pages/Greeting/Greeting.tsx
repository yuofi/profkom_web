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
import { completeAuthentication, peekAuthNotice } from "../../utils/authSession";
import { ERROR_TEXTS, userMessage } from "../../utils/api/messages";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { isWorkingSession, useSession } from "../../utils/session";
import { returnPath } from "../../utils/returnPath";

// The login routes answer with plain strings (old site): the texts go by status.
const LOGIN_TEXTS = {
  401: "Неверная почта или пароль. Если вы входили только через VK, войдите через VK.",
  403: "Вход недоступен: аккаунт заблокирован или в архиве.",
  // A login without @ that is not the service account's: the server checks the address.
  422: "Неправильный формат email",
};
const VK_TEXTS = {
  401: "Не удалось войти через VK. Повторите попытку.",
  403: LOGIN_TEXTS[403],
  // A VK of an existing account that is not linked yet (MIGRATION_V13.md): no second account.
  409: ERROR_TEXTS.vk_link_required,
  503: "VK временно недоступен. Повторите позже.",
};

export const GreetingPage = () => {
  // After a password change the page opens on the password form with the address (PE-21).
  // The note stays until the next login: the redirect may mount this page more than once.
  const [arrival] = useState(peekAuthNotice);
  const [signUp, setSignUp] = useState(!arrival);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The page a missing or ended session was sent here from (ProtectedRoute), checked (GL-13).
  const target = returnPath((useLocation().state as { from?: unknown } | null)?.from);
  const { session, loading } = useSession();

  const gradientClipPath =
    "M0.5 344.087V0.5H294.828C345.087 35.9281 365.664 60.4296 398.609 106.688L400.5 438.5H158.273C119.065 370.449 83.4742 347.686 0.5 344.087Z";

  // A new account signs up with VK and fills its application after; the form only logs in.
  const { formik, isSuccess, globalError, setGlobalError } = useForm({
    initialValues: { email: arrival?.email ?? "", password: "" },
    validationSchema: SignInValidationSchema,
    errorTexts: LOGIN_TEXTS,
    onSubmit: async (data) => {
      const response = await authApi.login({ email: data.email, password: data.password });
      await completeAuthentication(queryClient, response.data.access_token);
      // A temporary password is changed next: its page hands the address back to this form (PE-21).
      navigate(target, { replace: true, state: { email: data.email } });
    },
  });

  const handleLoginSuccess = async (data: TokenResult) => {
    setGlobalError(null);
    try {
      const response = await authApi.vkLogin({
        access_token: data.access_token, id_token: data.id_token,
      });
      await completeAuthentication(queryClient, response.data.access_token);
      navigate(target, { replace: true });
    } catch (error) {
      setGlobalError(userMessage(error, VK_TEXTS));
    }
  };
  const handleLoginError = () => {
    setGlobalError("Не удалось войти через VK. Повторите попытку.");
  };

  // Signed in already (a bookmark, «Назад» after the login): the workspace, not the form.
  // Pending, rejected and temporary-password sessions keep this page (GL-26).
  if (!loading && isWorkingSession(session))
    return <Navigate to={target} replace />;

  return (
    <div className={styles.container}>
      <title>
          {signUp ? "Регистрация | Профком ВМК" : "Вход | Профком ВМК"}
        </title>
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
                {/* Text, not email: the service account signs in with its login here. */}
                <FormTextField
                  name="email"
                  label="почта"
                  type="text"
                  inputMode="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                />

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
            <button
              type="button"
              className={styles.formSubheading}
              aria-expanded={!signUp}
              onClick={() => {
                setSignUp(!signUp);
                formik.resetForm();
                // An error of one way to log in says nothing about the other.
                setGlobalError(null);
              }}
            >
              {signUp ? "или войти с паролем" : "войти с вк"}
            </button>
            {arrival?.notice && <div role="status">{arrival.notice}</div>}
            {isSuccess && <div>Успешно!</div>}
            {globalError && <div role="alert" style={{ color: "var(--error)" }}>{globalError}</div>}
          </form>
        </FormikProvider>
      </CurvedRectangle>
    </div>
  );
};
