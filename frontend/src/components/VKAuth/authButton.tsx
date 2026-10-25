import { useEffect, useRef } from "react";
import * as VKID from "@vkid/sdk";
import { env } from "../../utils/env";

export interface VKAuthButtonProps {
  onSuccess?: (data: VKID.TokenResult) => void;
  onError?: (error: VKID.AuthError) => void;
}

export const VKAuthButton = ({ onSuccess, onError }: VKAuthButtonProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The page passes new handlers on every render; the widget is not rebuilt for that.
  const handlers = useRef({ onSuccess, onError });
  useEffect(() => {
    handlers.current = { onSuccess, onError };
  });
  const applicationId = Number(env.VITE_APP_ID);
  const configured = Number.isSafeInteger(applicationId) && applicationId > 0;

  useEffect(() => {
    if (!containerRef.current || !configured) return;
    const ref = containerRef.current;
    // A widget that failed to load reports it later, also after the password form replaced
    // the button: its events must not overwrite the answer to the password login.
    let active = true;
    VKID.Config.init({
      app: applicationId,
      redirectUrl: env.VITE_REDIRECT_URL,
      responseMode: VKID.ConfigResponseMode.Callback,
      source: VKID.ConfigSource.LOWCODE, 
      scope: "email phone",
    });

    const oneTap = new VKID.OneTap();
    containerRef.current.innerHTML = "";

    oneTap
      .render({
        container: containerRef.current,
        scheme: VKID.Scheme.DARK,
        showAlternativeLogin: true,
        skin: VKID.OneTapSkin.Primary,
        styles: {
          borderRadius: 16,
          width: 250,
          height: 56,
        },
      })
      .on(VKID.WidgetEvents.ERROR, (error: VKID.AuthError) => {
        if (active) handlers.current.onError?.(error);
      })
      .on(VKID.OneTapInternalEvents.LOGIN_SUCCESS, (payload: VKID.AuthResponse) => {
        const code = payload.code;
        const deviceId = payload.device_id;

        VKID.Auth.exchangeCode(code, deviceId)
          .then((data) => {
            if (active) handlers.current.onSuccess?.(data as VKID.TokenResult);
          })
          .catch((error: VKID.AuthError) => {
            if (active) handlers.current.onError?.(error);
          });
      });

    return () => {
      active = false;
      oneTap.close();
      ref.innerHTML = "";
    };
  }, [configured, applicationId]);

  return configured ? <div ref={containerRef}></div> : <p role="status">Вход через VK временно недоступен. Используйте почту и пароль.</p>;
};

export const VKOneTap = ({
  appId,
  redirectUrl = "https://example.com",
  state = "state",
  codeVerifier = "codeVerifier",
  scope = "phone email",
  onError,
  onSuccess,
}:
{
    appId: number;
    redirectUrl?: string;
    state?: string;
    codeVerifier?: string;
    scope?: string;
    onError?: (error: VKID.AuthError) => void;
    onSuccess?: (data: VKID.AuthResponse) => void;
} = {
  appId: 0,
  redirectUrl: "https://example.com",
  state: "state",
  codeVerifier: "codeVerifier",
  scope: "phone email",
  onError: () => {},
  onSuccess: () => {},
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Если контейнер еще не отрендерился, прерываем выполнение
    if (!containerRef.current) return;

    const ref = containerRef.current;

    VKID.Config.init({
      app: appId,
      redirectUrl: redirectUrl,
      state: state,
      codeVerifier: codeVerifier,
      scope: scope,
    });

    const oneTap = new VKID.OneTap();


    ref.innerHTML = "";

    oneTap
      .render({ container: ref })
      .on(VKID.OneTapInternalEvents.LOGIN_SUCCESS, (payload: VKID.AuthResponse) => {
        if(onSuccess) {
            onSuccess(payload);
        }
      })
      .on(VKID.WidgetEvents.ERROR, (error: VKID.AuthError) => {
        if (onError) {
          onError(error);
        } else {
          console.error("VK ID Error:", error);
        }
      });

    return () => {
      if (ref) {
        ref.innerHTML = "";
      }
    };
  }, [appId, redirectUrl, state, codeVerifier, scope, onError, onSuccess]);

  return (
    // Привязываем ref к div, в который VK ID встроит свой iframe/кнопку
    <div ref={containerRef} id="VkIdSdkOneTap" />
  );
};
