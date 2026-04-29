import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";
import Cookies from "js-cookie";
import { api } from "../index";

vi.mock("js-cookie");

describe("apiClient Interceptors", () => {
  let mock: MockAdapter;

  beforeEach(() => {
    mock = new MockAdapter(api);
    

    Object.defineProperty(window, "location", {
      value: { href: "" },
      writable: true,
    });
  });

  afterEach(() => {
    mock.restore();
    vi.clearAllMocks();
  });

  it("должен обновить токен и повторить оригинальный запрос при ошибке 401", async () => {
    const mockDoc = { id: "1", title: "Secret Doc" };
    const newTokens = { access_token: "new_acc", refresh_token: "new_ref" };

    vi.mocked(Cookies.get).mockReturnValue("old_refresh_token" as any);

    mock
      .onGet("/docs")
      .replyOnce(401)
      .onGet("/docs")
      .replyOnce(200, mockDoc);

    mock.onPost(new RegExp("/auth/refresh")).reply(200, newTokens);

    const response = await api.get("/docs");

    expect(response.status).toBe(200);
    expect(response.data).toEqual(mockDoc);
    
    expect(Cookies.set).toHaveBeenCalledWith("access_token", "new_acc");
  });

  it("должен редиректить на /login, если refresh-токен невалиден", async () => {
    vi.mocked(Cookies.get).mockReturnValue("bad_refresh_token" as any);

    mock.onGet("/docs").reply(401);
    
    mock.onPost(new RegExp("/auth/refresh")).reply(401);

    await expect(api.get("/docs")).rejects.toThrow();

    expect(Cookies.remove).toHaveBeenCalledWith("access_token");
    expect(Cookies.remove).toHaveBeenCalledWith("refresh_token");

    expect(window.location.href).toBe("/login");
  });
});