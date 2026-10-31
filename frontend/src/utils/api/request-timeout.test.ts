import { AxiosError } from "axios";
import MockAdapter from "axios-mock-adapter";
import { afterEach, expect, it } from "vitest";
import { api, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "./index";
import { userMessage } from "./messages";
import { normalizeApiError } from "./request";
import { tasksApi } from "./tasks.api";
import { requestKey, type RequestKey } from "../clientId";

let mock: MockAdapter | undefined;
afterEach(() => { mock?.restore();mock = undefined; });

it("GL-07: a read gives up after 20 s, a command waits 60 s", async () => {
  mock = new MockAdapter(api);
  mock.onAny().reply(config => [200, { timeout: config.timeout }]);
  expect((await api.get("/tasks")).data.timeout).toBe(READ_TIMEOUT_MS);
  expect((await api.post("/tasks", {})).data.timeout).toBe(WRITE_TIMEOUT_MS);
  expect((await api.patch("/tasks/t", {})).data.timeout).toBe(WRITE_TIMEOUT_MS);
  expect([READ_TIMEOUT_MS, WRITE_TIMEOUT_MS]).toEqual([20_000, 60_000]);
});

it("GL-07: no answer in time asks to check the result instead of blaming the connection", async () => {
  mock = new MockAdapter(api);
  mock.onPost("/slow").timeout();
  mock.onPost("/down").networkError();
  const slow = await api.post("/slow", {}).catch((error: unknown) => error);
  const down = await api.post("/down", {}).catch((error: unknown) => error);
  expect(userMessage(slow)).toBe("Сервер долго отвечает. Проверьте результат перед повтором.");
  expect(userMessage(down)).toBe("Нет связи с сервером. Проверьте подключение и повторите.");
  // The XHR adapter uses ECONNABORTED for a timeout and for a request the browser aborted.
  expect(normalizeApiError(new AxiosError("timeout of 60000ms exceeded", "ECONNABORTED")).code).toBe("timeout");
  expect(normalizeApiError(new AxiosError("timeout of 60000ms exceeded", "ETIMEDOUT")).code).toBe("timeout");
  expect(normalizeApiError(new AxiosError("Request aborted", "ECONNABORTED")).code).toBe("network_error");
});

it("GL-07: a repeat of the same comment carries the same key, a changed one a new key", async () => {
  mock = new MockAdapter(api);
  const keys: string[] = [];
  mock.onPost("/tasks/task-1/comments").reply(config => { keys.push(JSON.parse(config.data).idempotency_key);return [200, {}]; });
  const sent: RequestKey = { current: null };
  const payload = { body: "Текст", mentions: [], fileIds: [] };
  await tasksApi.comment("task-1", { format: "markdown", body: "Текст" }, [], [], requestKey(sent, payload));
  await tasksApi.comment("task-1", { format: "markdown", body: "Текст" }, [], [], requestKey(sent, { ...payload }));
  await tasksApi.comment("task-1", { format: "markdown", body: "Другой" }, [], [], requestKey(sent, { ...payload, body: "Другой" }));
  sent.current = null;
  await tasksApi.comment("task-1", { format: "markdown", body: "Другой" }, [], [], requestKey(sent, { ...payload, body: "Другой" }));
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[1]).toBe(keys[0]);
  expect(new Set(keys).size).toBe(3);
});
