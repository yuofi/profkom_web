import { useEffect, useRef } from "react";
import * as VKID from "@vkid/sdk";

export interface VKAuthButtonProps {
  onSuccess?: (data: Omit<VKID.TokenResult, "id_token">) => void; // Можно заменить `any` на точный тип ответа вашего бэкенда/VK
  onError?: (error: VKID.AuthError) => void;
}

export const VKAuthButton = ({ onSuccess, onError }: VKAuthButtonProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const ref = containerRef.current;
    VKID.Config.init({
      app: 54678274,
      redirectUrl: "https://5x4kxnk4-5173.euw.devtunnels.ms/",
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
        if (onError) onError(error);
      })
      .on(VKID.OneTapInternalEvents.LOGIN_SUCCESS, (payload: VKID.AuthResponse) => {
        const code = payload.code;
        const deviceId = payload.device_id;

        VKID.Auth.exchangeCode(code, deviceId)
          .then((data) => {
            if (onSuccess) onSuccess(data);
          })
          .catch((error: VKID.AuthError) => {
            if (onError) onError(error);
          });
      });

    // Функция очистки при размонтировании
    return () => {
      if (ref) {
        ref.innerHTML = "";
      }
    };
  }, [onSuccess, onError]);

  return <div ref={containerRef}></div>;
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

    // 1. Инициализация конфигурации
    VKID.Config.init({
      app: appId,
      redirectUrl: redirectUrl,
      state: state,
      codeVerifier: codeVerifier,
      scope: scope,
    });

    // 2. Создание экземпляра виджета
    const oneTap = new VKID.OneTap();

    // Очищаем контейнер перед рендером, чтобы избежать дублирования кнопок
    // при перерисовках компонента (например, в React Strict Mode)
    ref.innerHTML = "";

    // 3. Рендер виджета и подписка на события
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
