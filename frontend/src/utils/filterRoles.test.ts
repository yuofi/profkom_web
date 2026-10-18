import { expect, it } from "vitest";
import { createFixtures } from "../mocks/fixtures";
import { canEditGuide } from "./filterRoles";

it("recognizes a master and an independent deputy in the normalized block DTO used by legacy guide routes", () => {
  const f = createFixtures("leader");
  const block = f.blocks[0];
  const guide = { owner_block: block.name };
  block.master!.user = { user_id: f.profile.user_id, display_name: "Мастер", avatar_url: null };
  expect(canEditGuide(guide, f.profile, [block])).toBe(true);
  block.master!.user.user_id = 999;
  block.master!.deputy_user_ids = [f.profile.user_id];
  expect(canEditGuide(guide, f.profile, [block])).toBe(true);
  block.master!.deputy_user_ids = [];
  expect(canEditGuide(guide, f.profile, [block])).toBe(false);
  block.master!.deputy_user_ids = [f.profile.user_id];
  expect(canEditGuide({ owner_block: "Другой блок" }, f.profile, [block])).toBe(false);
  expect(canEditGuide({ owner_block: "none" }, f.profile, [block])).toBe(false);
});

it("retains compatibility with the old string master field", () => {
  const f = createFixtures("leader");
  expect(canEditGuide({ owner_block: "Инфо" }, f.profile, [{ name: "Инфо", master: f.profile.kkr_name, hr: "", cnt_of_human: 0, arr_of_human: [] }])).toBe(true);
});
