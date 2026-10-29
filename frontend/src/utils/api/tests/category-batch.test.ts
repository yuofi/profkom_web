import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../../mocks/transport";
import { membershipApi } from "../membership.api";
import { wireIssues } from "../../../test/wireContract";
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(() => { mock?.restore();mock = undefined; });
it("preserves the public DTO and sends sorted deduplicated bounded batches", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const ids = Array.from({ length: 401 }, (_, i) => 101 + i).reverse();
  await membershipApi.categories([...ids, 101]);
  const calls = mock.adapter.history.get.filter(r => r.url === "/participants/categories");
  expect(calls).toHaveLength(3);
  expect(calls.map(r => r.params.user_ids.split(",").length)).toEqual([200, 200, 1]);
  expect(calls[0].params.user_ids.split(",")[0]).toBe("101");
  const person = mock.state.people[0].user_id!;
  const single = await membershipApi.category(person);
  const batch = await membershipApi.categories([person, person]);
  expect(batch).toEqual([single]);expect(wireIssues("ParticipantCategoryBatch", { items: batch })).toEqual([]);
  expect(wireIssues("ParticipantCategoryBatch", { items: [{ ...single, reason: "private" }] })).not.toEqual([]);
});
it("an empty contact list starts no category request", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  expect(await membershipApi.categories([])).toEqual([]);
  expect(mock.adapter.history.get).toHaveLength(0);
});
