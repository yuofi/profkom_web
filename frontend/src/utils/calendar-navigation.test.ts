import { expect, it } from "vitest";
import { monthDays, monthTitle, shiftMonth } from "./calendar";

it("moves a month across years and keeps Moscow month boundaries", () => {
  expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  expect(shiftMonth("2027-01", -1)).toBe("2026-12");
  expect(shiftMonth("2028-01", 1)).toBe("2028-02");
  const leap = monthDays("2028-02");
  expect(leap.days).toHaveLength(29);
  expect(leap.from).toBe("2028-01-31T21:00:00.000Z");
  expect(leap.to).toBe("2028-02-29T20:59:59.999Z");
  expect(monthTitle("2026-10")).toBe("октябрь 2026");
});
