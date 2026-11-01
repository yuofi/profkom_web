// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../../utils/api/request";
import { QueryState } from "./WorkspaceUI";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | undefined, client: QueryClient | undefined;
afterEach(async () => { await act(async () => root?.unmount());client?.clear();root = client = undefined;document.body.innerHTML = ""; });
const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

it("GL-38: a page without its own retry still offers «Обновить данные» after a transient failure", async () => {
  const read = vi.fn().mockRejectedValueOnce(new ApiError("Ошибка на сервере", 503, "unavailable")).mockResolvedValue("Отчёт");
  function Screen() {
    const query = useQuery({ queryKey: ["reports", "list"], queryFn: read });
    return <QueryState loading={query.isLoading} error={query.error}><p>{query.data}</p></QueryState>;
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");document.body.append(container);root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={client!}><Screen /></QueryClientProvider>));await tick();
  const button = [...container.querySelectorAll("button")].find(node => node.textContent === "Обновить данные");
  expect(button).toBeDefined();
  await act(async () => button!.click());await tick();
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe("Отчёт");
});

it("GL-38: a refusal is final and an error outside queries gets no dead button", async () => {
  client = new QueryClient();
  const container = document.createElement("div");document.body.append(container);root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={client!}>
    <QueryState loading={false} error={new ApiError("Нет доступа", 403, "forbidden")}><p /></QueryState>
    <QueryState loading={false} error={new ApiError("Ошибка на сервере", 503, "unavailable")}><p /></QueryState>
  </QueryClientProvider>));
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2);
  expect([...container.querySelectorAll("button")].filter(node => node.textContent === "Обновить данные")).toHaveLength(0);
});
