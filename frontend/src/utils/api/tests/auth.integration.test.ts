import { beforeEach, describe, expect, it } from "vitest";
import axios from "axios";
import Cookies from "js-cookie";
import { authApi } from "../auth.api";
import { api } from "../index";
import { materialsApi } from "../materials.api";
import { membershipApi } from "../membership.api";
import { directoryApi } from "../directory.api";
import { richText } from "../contract";

const synthetic = () => ({
  email: `integration_${crypto.randomUUID()}@example.com`,
  password: "Synthetic-Integration-2026",
  name: "Участник", surname: "Тестовый", patronymic: "",
  group_number: 301, tg: "@profkom_test", phone: "+79990000000",
  vk: "https://vk.com/id123", funding: "budget" as const, residence: "Тест",
});
const chair = axios.create({ baseURL: api.defaults.baseURL, timeout: 10000 });
async function chairHeaders() {
  const r = await chair.post("/auth/login", { email: "chair@example.com", password: "Synthetic-Local-2026" });
  return { Authorization: `Bearer ${r.data.access_token}` };
}

describe("Disposable local API 1.3 integration", () => {
  beforeEach(() => Cookies.remove("access_token"));

  it("registers a pending account, approves the same ID and opens safe directory DTOs", async () => {
    const person = synthetic();
    const registration = await authApi.register(person);
    expect(registration.status).toBe(201);
    Cookies.set("access_token", registration.data.access_token);
    const pending = (await api.get("/session")).data;
    expect(pending.account_state).toBe("pending");
    await expect(authApi.getMe()).rejects.toMatchObject({ response: { status: 403 } });
    const own = (await api.get("/registrations/me")).data;
    const headers = await chairHeaders();
    await chair.post(`/registrations/${pending.user_id}/approve`, { expected_revision: own.revision }, { headers });
    expect((await api.get("/session")).data.account_state).toBe("active");
    expect((await authApi.getMe()).data.email).toBe(person.email);
    const contacts = await directoryApi.contacts();
    expect(contacts.some(c => c.user_id === pending.user_id)).toBe(true);
    expect(contacts.every(c => !("kkr_score" in c) && !("events_roles" in c))).toBe(true);
    const blocks = await membershipApi.blocks();
    expect(blocks.every(b => typeof b.block_id === "string" && !!b.guide_material_id)).toBe(true);
  });

  it("uses the frontend material client through persisted draft and publication", async () => {
    const headers = await chairHeaders();
    Cookies.set("access_token", headers.Authorization.slice(7));
    const material = await materialsApi.create({ kind: "general", title: "Integration", description: "Synthetic", content: richText("Old") });
    const published = await materialsApi.publish(material.material_id, { expected_revision: material.revision });
    const draft = await materialsApi.update(material.material_id, { expected_revision: published.revision, content: richText("**New**") });
    expect(draft.published_content?.body).toBe("Old");
    expect(draft.draft_content?.body).toBe("**New**");
    await materialsApi.publish(material.material_id, { expected_revision: draft.revision });
    const read = await materialsApi.get(material.material_id);
    expect(read.published_content?.body).toBe("**New**");
    expect(read.draft_content).toBeUndefined();
  });
});
