// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, expect, it } from "vitest";
import { UserProvider } from "./ctx";
import { useSession } from "./session";
import { createFixtures } from "../mocks/fixtures";
import { installMockTransport } from "../mocks/transport";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let mock: ReturnType<typeof installMockTransport> | undefined;
let root: ReturnType<typeof createRoot> | undefined;
let client: QueryClient | undefined;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  mock?.restore();
  client?.clear();
  document.body.innerHTML = "";
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
it("removes private cache before rendering the replacement session", async () => {
  const before = createFixtures("chair");
  mock = installMockTransport("organizer", { delay: 0 });
  client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["session"], before.session);
  client.setQueryData(["currentUser", before.session.user_id], {
    data: before.profile,
  });
  client.setQueryData(["private-object"], "Закрытое содержимое");
  const observations: { userId: number | undefined; secret: unknown }[] = [];
  function Observer() {
    const { session } = useSession();
    observations.push({
      userId: session?.user_id,
      secret: client!.getQueryData(["private-object"]),
    });
    return <span>{session?.user_id}</span>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <UserProvider>
          <Observer />
        </UserProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await client!.refetchQueries({ queryKey: ["session"] });
    await settle();
  });
  const changed = observations.filter((o) => o.userId === 101);
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.every((o) => o.secret === undefined)).toBe(true);
  expect(container.textContent).toBe("101");
});
it("never starts a profile or workspace request while the account is pending", async () => {
  mock = installMockTransport("pending", { delay: 0 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <UserProvider>
          <span>gate</span>
        </UserProvider>
      </QueryClientProvider>,
    );
    await settle();
  });
  await act(settle);
  expect(mock.adapter.history.get.map((r) => r.url)).toEqual(["/session"]);
});

it("evicts an inactive catalogue with a disabled observer when access changes", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["session"], mock.state.session);
  client.setQueryData(["currentUser", mock.state.session.user_id], { data: mock.state.profile });
  client.setQueryData(["private-filter-options"], ["Closed team"]);
  let openFilter: (() => void) | undefined;
  const openedValues: string[] = [];
  function ClosedFilter() {
    const [open, setOpen] = useState(false);
    openFilter = () => setOpen(true);
    const query = useQuery({ queryKey: ["private-filter-options"], queryFn: async () => ["Newly allowed team"], enabled: open });
    if (open) openedValues.push(JSON.stringify(query.data ?? []));
    return <span>Filter closed</span>;
  }
  const container = document.createElement("div");document.body.append(container);root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={client!}><UserProvider><ClosedFilter /></UserProvider></QueryClientProvider>));
  expect(client.getQueryCache().find({ queryKey: ["private-filter-options"] })?.getObserversCount()).toBe(1);
  mock.state.session = { ...mock.state.session, access_revision: "revoked-filter-access" };
  await act(async () => { await client!.refetchQueries({ queryKey: ["session"] });await settle(); });
  expect(client.getQueryData(["private-filter-options"])).toBeUndefined();
  expect(mock.adapter.history.get.some(request => request.url?.includes("private-filter-options"))).toBe(false);
  await act(async () => { openFilter!();await settle(); });
  expect(openedValues.length).toBeGreaterThan(0);
  expect(openedValues.every(value => !value.includes("Closed team"))).toBe(true);
  expect(client.getQueryData(["private-filter-options"])).toEqual(["Newly allowed team"]);
});
