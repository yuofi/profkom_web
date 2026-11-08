import { expect, it } from "vitest";
import { metricValue } from "./seasonAnalyticsView";

// Group separators are a no-break space (U+00A0 or the narrow U+202F, by ICU version).
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");

it("prints hours, evaluations and KKR the Russian way: a decimal comma, spaced thousands, at most two decimals", () => {
  expect(metricValue(2.5)).toBe("2,5");
  expect(metricValue(1.5)).toBe("1,5");
  expect(metricValue(4)).toBe("4");
  expect(metricValue(0)).toBe("0");
  expect(plain(metricValue(1123.567))).toBe("1 123,57");
  expect(metricValue(2.5)).not.toContain(".");
});
it("prints an absent value as a dash", () => {
  expect(metricValue(null)).toBe("—");
  expect(metricValue(undefined)).toBe("—");
});
