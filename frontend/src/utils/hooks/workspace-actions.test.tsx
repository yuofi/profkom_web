// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { useNotificationCommands, useWorkspaceActions } from "./useWorkspace";
import { workspaceApi } from "../api/workspace.api";
import type { Notification, Page } from "../api/contract";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | undefined, client: QueryClient | undefined;
afterEach(async () => { await act(async () => root?.unmount()); client?.clear(); root = client = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });

type Hooks = { actions: ReturnType<typeof useWorkspaceActions>; notices: ReturnType<typeof useNotificationCommands> };
async function mount(reads: Record<string, () => Promise<unknown>>) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const hooks = {} as Hooks;
  function Harness() {
    hooks.actions = useWorkspaceActions();hooks.notices = useNotificationCommands();
    for (const [name, read] of Object.entries(reads))
      // eslint-disable-next-line react-hooks/rules-of-hooks -- a fixed set of observers per test
      useQuery({ queryKey: name === "notifications" ? ["notifications"] : ["tasks", name], queryFn: read });
    return null;
  }
  const container = document.createElement("div");document.body.append(container);root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={client!}><Harness /></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  return hooks;
}

it("PF-02: a command is done when the server answered; its own answer is not reread", async () => {
  let release: (() => void) | undefined;
  const own = vi.fn(async () => ({ revision: 1 }));
  const list = vi.fn(() => list.mock.calls.length === 1 ? Promise.resolve(["first"]) : new Promise(resolve => { release = () => resolve(["second"]); }));
  const hooks = await mount({ "task-1": own, page: list });
  expect(own).toHaveBeenCalledTimes(1);expect(list).toHaveBeenCalledTimes(1);
  let result: unknown;
  await act(async () => {
    result = await hooks.actions.perform(async () => { client!.setQueryData(["tasks", "task-1"], { revision: 2 });return "saved"; });
  });
  // The dependent list is rereading in the background, the command has already returned.
  expect(result).toBe("saved");expect(list).toHaveBeenCalledTimes(2);expect(release).toBeDefined();
  expect(client!.getQueryState(["tasks", "page"])?.fetchStatus).toBe("fetching");
  expect(own).toHaveBeenCalledTimes(1);expect(client!.getQueryData(["tasks", "task-1"])).toEqual({ revision: 2 });
  await act(async () => { release!();await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(client!.getQueryData(["tasks", "page"])).toEqual(["second"]);
});

it("PF-02: an older read still in flight is reread after the command's own answer", async () => {
  let calls = 0, releaseOld: ((value: unknown) => void) | undefined;
  const own = vi.fn(() => ++calls === 2 ? new Promise(resolve => { releaseOld = resolve; }) : Promise.resolve({ revision: calls }));
  const hooks = await mount({ "task-1": own });
  void client!.refetchQueries({ queryKey: ["tasks", "task-1"] });
  await act(async () => { await hooks.actions.perform(async () => { client!.setQueryData(["tasks", "task-1"], { revision: 9 }); }); });
  await act(async () => { releaseOld?.({ revision: 0 });await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(own).toHaveBeenCalledTimes(3);expect(client!.getQueryData(["tasks", "task-1"])).toEqual({ revision: 3 });
});

const notices = (): Page<Notification> => ({ next_cursor: null, items: [
  { id: "n1", kind: "task_status", text: "Первое", created_at: "2026-10-30T10:00:00Z", read_at: null, target: null },
  { id: "n2", kind: "task_status", text: "Второе", created_at: "2026-10-30T09:00:00Z", read_at: null, target: null },
] } as unknown as Page<Notification>);

it("PF-02: reading a notice updates the notices at once and rereads only them", async () => {
  let answered: (() => void) | undefined;
  const read = vi.spyOn(workspaceApi, "read").mockImplementation(() => new Promise(resolve => { answered = () => resolve(undefined); }));
  const list = vi.fn(async () => notices()), task = vi.fn(async () => ({ revision: 1 }));
  const hooks = await mount({ notifications: list, "task-1": task });
  let pending: Promise<void> | undefined;
  await act(async () => { pending = hooks.notices.read("n1");await new Promise(resolve => setTimeout(resolve, 5)); });
  // Shown read before the server answered.
  expect(client!.getQueryData<Page<Notification>>(["notifications"])!.items.map(item => !!item.read_at)).toEqual([true, false]);
  await act(async () => { answered!();await pending;await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(read).toHaveBeenCalledExactlyOnceWith("n1");expect(list).toHaveBeenCalledTimes(2);expect(task).toHaveBeenCalledTimes(1);
});

it("PF-02: a failed read-all restores the notices", async () => {
  vi.spyOn(workspaceApi, "readAll").mockRejectedValue(new Error("Нет связи"));
  let answer = notices();
  const list = vi.fn(async () => answer);
  const hooks = await mount({ notifications: list });
  answer = notices();
  await act(async () => { await expect(hooks.notices.readAll()).rejects.toThrow("Нет связи"); });
  expect(client!.getQueryData<Page<Notification>>(["notifications"])!.items.every(item => !item.read_at)).toBe(true);
});
