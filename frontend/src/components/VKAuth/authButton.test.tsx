// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

type Handler = (payload: unknown) => void;
const sdk = vi.hoisted(() => ({
  widgets: [] as { handlers: Record<string, Handler>; close: () => void }[],
  exchange: vi.fn(),
}));
vi.mock("../../utils/env", () => ({ env: { VITE_APP_ID: "123", VITE_REDIRECT_URL: "https://example.org/auth" } }));
vi.mock("@vkid/sdk", () => {
  class OneTap {
    handlers: Record<string, Handler> = {};
    close = vi.fn();
    constructor() { sdk.widgets.push(this); }
    render() { return this; }
    on(event: string, handler: Handler) { this.handlers[event] = handler; return this; }
  }
  return {
    Config: { init: vi.fn() }, OneTap, Auth: { exchangeCode: sdk.exchange },
    ConfigResponseMode: { Callback: "callback" }, ConfigSource: { LOWCODE: "lowcode" }, Scheme: { DARK: "dark" },
    OneTapSkin: { Primary: "primary" }, WidgetEvents: { ERROR: "error" }, OneTapInternalEvents: { LOGIN_SUCCESS: "login_success" },
  };
});
import { VKAuthButton } from "./authButton";

const host = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; sdk.widgets.length = 0; sdk.exchange.mockReset(); });

it("the login page: one widget for all renders, and nothing from it once the password form replaced it", async () => {
  // On test.profcom-cmc.online VK ID failed to load and reported it after the password
  // login had answered 403: «Не удалось войти через VK» replaced «Вход недоступен».
  const first = vi.fn(), latest = vi.fn();
  root = createRoot(host);
  act(() => root!.render(<VKAuthButton onError={first} />));
  act(() => root!.render(<VKAuthButton onError={latest} />));
  expect(sdk.widgets).toHaveLength(1);
  const [widget] = sdk.widgets;
  act(() => widget.handlers.error({ code: 0 }));
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);

  let exchanged!: (data: unknown) => void;
  sdk.exchange.mockReturnValue(new Promise((resolve) => { exchanged = resolve; }));
  const success = vi.fn();
  act(() => root!.render(<VKAuthButton onError={latest} onSuccess={success} />));
  act(() => widget.handlers.login_success({ code: "code", device_id: "device" }));
  act(() => root!.unmount());
  root = undefined;
  expect(widget.close).toHaveBeenCalledTimes(1);
  widget.handlers.error({ code: 0 });
  await act(async () => exchanged({ access_token: "synthetic" }));
  expect(latest).toHaveBeenCalledTimes(1);
  expect(success).not.toHaveBeenCalled();
});
