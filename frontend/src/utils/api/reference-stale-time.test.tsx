// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { invalidateWorkspace, referenceStaleTime } from "./invalidation";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | undefined, client: QueryClient | undefined;
afterEach(async () => { await act(async () => root?.unmount()); client?.clear(); document.body.innerHTML = ""; });
const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

it("PF-09: a directory is reused by a remount, a private read is not, an own change rereads both", async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: referenceStaleTime } } });
  const contacts = vi.fn(async () => ["Иванов"]), task = vi.fn(async () => ({ title: "Задача" }));
  let show: (value: boolean) => void = () => {};
  function Card() {
    useQuery({ queryKey: ["contacts"], queryFn: contacts });
    useQuery({ queryKey: ["tasks", "task-1"], queryFn: task });
    return null;
  }
  function Screen() { const [shown, setShown] = useState(true);show = setShown;return <>{shown && <Card />}<Card /></>; }
  const container = document.createElement("div");document.body.append(container);root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={client!}><Screen /></QueryClientProvider>));await tick();
  expect(contacts).toHaveBeenCalledTimes(1);expect(task).toHaveBeenCalledTimes(1);
  await act(async () => show(false));await act(async () => show(true));await tick();
  expect(contacts).toHaveBeenCalledTimes(1);expect(task).toHaveBeenCalledTimes(2);
  await act(async () => { await invalidateWorkspace(client!); });
  expect(contacts).toHaveBeenCalledTimes(2);expect(task).toHaveBeenCalledTimes(3);
  // A query that only starts with a directory's key is not a directory.
  expect(referenceStaleTime(client.getQueryCache().find({ queryKey: ["tasks", "task-1"] })!)).toBe(0);
  expect(referenceStaleTime(client.getQueryCache().find({ queryKey: ["contacts"] })!)).toBeGreaterThan(0);
});
