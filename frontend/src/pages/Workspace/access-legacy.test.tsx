// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { AxiosError } from "axios";
import MockAdapter from "axios-mock-adapter";
import { z } from "zod";
import { api } from "../../utils/api";
import { useForm } from "../../components/Form/Form";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle, change, field, submit } from "../../test/workspace";
import { AdminPanel } from "../Admin/AdminPage";
import { ExtendedRoute } from "../Wrappers/wrappers";
import { BlocksPage, RegistrationsPage } from "./MembershipPages";
import { EventsListPage } from "./EventPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; restore?.(); restore = undefined; });

it.each([
  ["users", "Регистрации"], ["blocks", "Блоки"], ["events", "Мероприятия"],
])("A01: old admin/%s opens the current domain screen", async (tab, title) => {
  const mock = installMockTransport("chair", { delay: 0 }); restore = mock.restore;
  page = await mountWorkspace(
    <Routes>
      <Route element={<ExtendedRoute />}><Route path="/admin/:tab" element={<AdminPanel />} /></Route>
      <Route path="/registrations" element={<RegistrationsPage />} />
      <Route path="/blocks" element={<BlocksPage />} />
      <Route path="/events" element={<EventsListPage />} />
    </Routes>,
    { path: `/admin/${tab}` },
  );
  await settle(); await settle();
  expect(page.container.querySelector("h1")?.textContent).toContain(title);
  expect(page.container.textContent).not.toContain("Добавить блок");
  expect(mock.adapter.history.patch).toHaveLength(0);
  expect(mock.adapter.history.post).toHaveLength(0);
});

it.each([403, 409, 422])("A02: retained form renders structured %i and preserves input", async (status) => {
  function Probe() {
    const { formik, globalError } = useForm({
      initialValues: { title: "" }, validationSchema: z.object({ title: z.string() }),
      onSubmit: async () => { throw new AxiosError("request failed", undefined, undefined, undefined, {
        status, statusText: "Error", headers: {}, config: { headers: {} } as never,
        data: { detail: { code: "invalid_input", message: "Проверьте сведения", fields: { title: "Уточните название" } } },
      }); },
    });
    return <form onSubmit={formik.handleSubmit}><input {...formik.getFieldProps("title")} />
      <p role="alert">{globalError}</p><span>{formik.errors.title}</span><button type="submit">Отправить</button></form>;
  }
  page = await mountWorkspace(<Probe />);
  await change(field(page.container, "title"), "Мой черновик");
  await submit(page.container.querySelector("form")!);
  expect(page.container.textContent).toContain("Проверьте сведения");
  expect(page.container.textContent).toContain("Уточните название");
  expect(field(page.container, "title").value).toBe("Мой черновик");
});

it("A02: adapter errors and FastAPI field errors use the same normalizer", async () => {
  const adapter = new MockAdapter(api); restore = () => adapter.restore();
  adapter.onPost("/form-error").reply(422, { detail: [{ loc: ["body", "title"], msg: "Нужно название" }] });
  function Probe() {
    const { formik, globalError } = useForm({ initialValues: { title: "draft" }, validationSchema: z.object({ title: z.string() }), onSubmit: async () => { await api.post("/form-error"); } });
    return <form onSubmit={formik.handleSubmit}><input {...formik.getFieldProps("title")} /><p role="alert">{globalError}</p><span>{formik.errors.title}</span><button type="submit">Отправить</button></form>;
  }
  page = await mountWorkspace(<Probe />);
  await submit(page.container.querySelector("form")!);
  expect(page.container.textContent).toContain("Проверьте заполнение полей");
  expect(page.container.textContent).toContain("Нужно название");
  expect(page.container.textContent).not.toContain("Request failed");
});
