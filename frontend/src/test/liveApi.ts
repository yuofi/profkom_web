import Cookies from "js-cookie";
import { authApi } from "../utils/api/auth.api";
import { sessionApi } from "../utils/api/session.api";
import { membershipApi } from "../utils/api/membership.api";
import { seasonsApi } from "../utils/api/seasons.api";
import { eventsApi } from "../utils/api/events.api";
import { tasksApi } from "../utils/api/tasks.api";
import { reportsApi } from "../utils/api/reports.api";
import { richText } from "../utils/api/contract";

export const livePassword = "Synthetic-Local-2026";
export async function liveLogin(email = "chair@example.com") {
  const response = await authApi.login({ email, password: livePassword });
  Cookies.set("access_token", response.data.access_token);
  return sessionApi.get();
}
export async function liveParticipant(label: string) {
  const email = `integration-${label}-${crypto.randomUUID()}@example.com`;
  const response = await authApi.register({ email, password: livePassword,
    surname: "Тестовый", name: label, patronymic: "", group_number: 301, tg: "@profkom_test",
    phone: "+79990000000", vk: "https://vk.com/id123", funding: "budget", residence: "Тест" });
  Cookies.set("access_token", response.data.access_token);
  const pending = await sessionApi.get();
  const application = await membershipApi.registration();
  await liveLogin();
  await membershipApi.registrationCommand(pending.user_id, "approve", { expected_revision: application.revision });
  return { user_id: pending.user_id, email };
}

/** Finish disposable data through authorized commands; public task status never substitutes private accounting. */
// liveCloseSeasons publishes a final report for every event and subevent the earlier files
// left open, one after another. That grows with the suite and with the file order Vitest
// picks from its last results, so the tests calling it get more than the default 30 s.
export const CLOSES_SEASONS_TIMEOUT = 120_000;
export async function liveCloseSeasons() {
  const chair = await liveLogin();
  for (const season of (await seasonsApi.list()).items.sort((a, b) => a.sequence_number - b.sequence_number)) {
    if (season.state === "closed") continue;
    for (const task of (await tasksApi.list({ season_id: season.season_id, mine: false })).items) {
      if (task.scope.kind === "queue") continue;
      for (const assignment of task.assignments) {
        const inputs = await tasksApi.assessment(assignment.assignment_id);
        if (!inputs.workflow_status || typeof inputs.workflow_revision !== "number") throw Error("Disposable scoped assignment has no private workflow version");
        if (!["accepted", "cancelled", "not_completed"].includes(inputs.workflow_status))
          await tasksApi.command(assignment.assignment_id, "cancel", { expected_revision: inputs.workflow_revision, reason: "Finish disposable private accounting fixture" });
      }
    }
    for (const event of (await eventsApi.list({ season_id: season.season_id })).items) {
      await eventsApi.leaders("events", event.event_id, [chair.user_id], { expected_revision: event.revision });
      const owners: { owner_kind: "event" | "subevent"; owner_id: string }[] = [{ owner_kind: "event", owner_id: event.event_id }];
      for (const sub of (await eventsApi.subevents(event.event_id)).items) {
        await eventsApi.leaders("subevents", sub.subevent_id, [chair.user_id], { expected_revision: sub.revision });
        owners.push({ owner_kind: "subevent", owner_id: sub.subevent_id });
      }
      for (const owner of owners) {
        let final = (await reportsApi.list(owner)).items.find(r => r.kind === "final");
        final ??= await reportsApi.create({ ...owner, kind: "final", title: "Итог тестового экземпляра", content: richText("Test completion"), file_ids: [] });
        if (final.state !== "published") await reportsApi.publish(final.report_id, { expected_revision: final.revision });
      }
    }
    let current = (await seasonsApi.list()).items.find(s => s.season_id === season.season_id)!;
    if (current.state === "planned") {
      const response = await seasonsApi.command(current.season_id, "open", { expected_revision: current.revision });
      current = "season" in response ? response.season : response;
    }
    if (current.state === "open") {
      const response = await seasonsApi.command(current.season_id, "begin-summary", { expected_revision: current.revision });
      current = "season" in response ? response.season : response;
    }
    await seasonsApi.command(current.season_id, "close", { expected_revision: current.revision });
  }
}
