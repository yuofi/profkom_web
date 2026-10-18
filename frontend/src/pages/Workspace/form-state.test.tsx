// @vitest-environment jsdom
import { act, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle, change, field, submit } from "../../test/workspace";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { EventPage } from "./EventPages";
import { BlockPage } from "./MembershipPages";
import { AccountStatePage } from "./SessionPages";
import { MeetingPage } from "./ReportPages";
import { SeasonPage, SummaryPage } from "./SeasonPages";
import { seasonsApi } from "../../utils/api/seasons.api";
import { QueryState } from "../../components/Workspace/WorkspaceUI";
import { ApiError } from "../../utils/api/request";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });

async function clickButton(container: ParentNode, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!button) throw Error(`Missing button: ${text}`);
  await act(async () => button.click()); await settle();
}
const acknowledge = (form: HTMLFormElement) => clickButton(form, "Сохранить мой ввод с обновлённой версией");

it.each(["event", "block", "registration", "meeting", "season", "decisions"] as const)("A05: %s retains its draft through 409, refresh, consent and retry", async (kind) => {
  const role = kind === "registration" ? "pending" : "chair";
  mock = installMockTransport(role, { delay: 0 });
  const routes = {
    event: ["/events/event-1", "/events/:id", <EventPage />, "description"],
    block: [`/blocks/${mock.state.blocks[0].block_id}`, "/blocks/:id", <BlockPage />, "body"],
    registration: ["/", "/", <AccountStatePage />, "phone"],
    meeting: ["/meetings/subevent/subevent-1", "/meetings/:kind/:id", <MeetingPage />, "title"],
    season: ["/seasons/season-1", "/seasons/:id", <SeasonPage />, "title"],
    decisions: ["/seasons/season-1/summary", "/seasons/:id/summary", <SummaryPage />, "reason"],
  } as const;
  const [path, route, element, name] = routes[kind];
  page = await mountWorkspace(<Routes><Route path={route} element={element} /></Routes>, { role, path });
  await settle(); await settle();
  const form = kind === "event" ? Array.from(page.container.querySelectorAll("form")).find((f) => f.querySelector<HTMLInputElement>('[name="title"]')?.value === mock!.state.events[0].title && f.querySelector('[name="description"]'))! : field(page.container, name).closest("form")!;
  await change(field(form, name), "МОЙ НЕСОХРАНЁННЫЙ ТЕКСТ");
  if (kind === "season") await change(field(form, "reason"), "Уточнение плановых дат");
  const record = kind === "event" ? mock.state.events[0] : kind === "block" ? mock.state.blocks[0] : kind === "registration" ? mock.state.registration : kind === "meeting" ? mock.state.meetings[0] : mock.state.seasons.find((s) => s.season_id === "season-1")!;
  let latestRevision: number;
  if (kind === "decisions") latestRevision = (await seasonsApi.decisions("season-1", mock.state.people[0].user_id!, { expected_version: 1, decisions: [], reason: "Другой редактор" })).version;
  else latestRevision = ++record.revision;
  await submit(form);
  expect(form.querySelector('[role="alert"]'), page.container.textContent ?? "").not.toBeNull();
  await clickButton(form, "Обновить данные");
  expect(form.isConnected).toBe(true);
  expect(field(form, name).value).toBe("МОЙ НЕСОХРАНЁННЫЙ ТЕКСТ");
  const mutations = () => [...mock!.adapter.history.post, ...mock!.adapter.history.patch, ...mock!.adapter.history.put].filter((r) => r.data && /expected_revision|expected_version/.test(r.data));
  const beforeConsent = mutations().length;
  await submit(form);
  expect(mutations()).toHaveLength(beforeConsent);
  await acknowledge(form);
  await submit(form);
  expect(mutations()).toHaveLength(beforeConsent + 1);
  const payload = JSON.parse(mutations().at(-1)!.data);
  expect(payload.expected_revision ?? payload.expected_version).toBe(latestRevision);
  expect(form.querySelector('[role="alert"]'), page.container.textContent ?? "").toBeNull();
});

it("A05: background revisions do not silently authorize overwriting a draft", async () => {
  const save = vi.fn(async () => {});
  function Probe() {
    const [revision, setRevision] = useState(1);
    return <><button onClick={() => setRevision(2)}>External update</button><ActionForm revision={revision} fields={[{ name: "title", label: "Название", value: revision === 1 ? "Старое" : "Серверное" }]} onSubmit={save} /></>;
  }
  page = await mountWorkspace(<Probe />);
  await change(field(page.container, "title"), "Мой черновик");
  await clickButton(page.container, "External update");
  const form = page.container.querySelector("form")!;
  expect(form.textContent).toContain("Серверное");
  expect(field(form, "title").value).toBe("Мой черновик");
  await submit(form);
  expect(save).not.toHaveBeenCalled();
  await acknowledge(form); await submit(form);
  expect(save).toHaveBeenCalledWith({ title: "Мой черновик" }, 2);
});

it("A05: a failed refresh retains the same editor; a denied read removes it", async () => {
  function Probe() {
    const [error, setError] = useState<unknown>(null);
    return <><button onClick={() => setError(new ApiError("Сеть недоступна", 503))}>Network error</button><button onClick={() => setError(new ApiError("Нет доступа", 403))}>Revoke</button><QueryState loading={false} error={error} keepDataOnError><ActionForm fields={[{ name: "title", label: "Название" }]} onSubmit={async () => {}} /></QueryState></>;
  }
  page = await mountWorkspace(<Probe />);
  const form = page.container.querySelector("form");
  await change(field(page.container, "title"), "Мой ввод");
  await clickButton(page.container, "Network error");
  expect(page.container.querySelector("form")).toBe(form);
  expect(field(page.container, "title").value).toBe("Мой ввод");
  await clickButton(page.container, "Revoke");
  expect(page.container.querySelector("form")).toBeNull();
});
