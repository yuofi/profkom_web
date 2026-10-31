import { expect, it } from "vitest";
import { initials } from "./initials";

it("takes letters and digits only and skips words without them (EV-22)", () => {
  expect(initials("Хакатон «Код осени»")).toBe("ХК");
  expect(initials("Посвят — прошлый год")).toBe("ПП");
  expect(initials("(Квиз) 2026")).toBe("К2");
  expect(initials("  ёлка  ")).toBe("Ё");
  expect(initials("— «»")).toBe("");
  expect(initials("Анна Мария Иванова", 3)).toBe("АМИ");
});
