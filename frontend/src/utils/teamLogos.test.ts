import { describe, expect, it } from "vitest";
import { blockLogo, DAY_OF_CAREER_LOGO, eventLogo } from "./teamLogos";

describe("explicit cosmetic logo presets", () => {
  it("normalizes the supplied aliases without guessing an unrelated team's identity", () => {
    expect(blockLogo("КГ")).toBe(blockLogo("Креативная группа"));
    expect(blockLogo("КГ")).toBeTruthy();
    expect(blockLogo("Зачёт".normalize("NFD"))).toBe(blockLogo("Зачет"));
    expect(blockLogo("Произвольный IT блок")).toBeUndefined();
    expect(blockLogo(null)).toBeUndefined();
  });
  it("uses the career image for the event only", () => {
    expect(eventLogo("ДК 2026")).toBe(DAY_OF_CAREER_LOGO);
    expect(eventLogo("День карьеры")).toBe(DAY_OF_CAREER_LOGO);
    expect(blockLogo("День карьеры")).toBeUndefined();
    expect(blockLogo("ДК")).toBeUndefined();
    expect(eventLogo("ДК другого факультета")).toBeUndefined();
  });
});
