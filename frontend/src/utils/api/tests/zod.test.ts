import { describe, it, expect } from "vitest";
import { isValidGroupNumber, SignUpValidationSchema, ProfileValidationSchema } from "../zod";

describe("isValidGroupNumber", () => {
  it("should accept valid group numbers from 100 to 700", () => {
    expect(isValidGroupNumber("100")).toBe(true);
    expect(isValidGroupNumber("101")).toBe(true);
    expect(isValidGroupNumber("215")).toBe(true);
    expect(isValidGroupNumber("501")).toBe(true);
    expect(isValidGroupNumber("700")).toBe(true);
    expect(isValidGroupNumber(100)).toBe(true);
    expect(isValidGroupNumber(700)).toBe(true);
  });

  it("should reject group numbers below 100 or above 700", () => {
    expect(isValidGroupNumber("99")).toBe(false);
    expect(isValidGroupNumber("0")).toBe(false);
    expect(isValidGroupNumber("-100")).toBe(false);
    expect(isValidGroupNumber("701")).toBe(false);
    expect(isValidGroupNumber("1000")).toBe(false);
    expect(isValidGroupNumber(99)).toBe(false);
    expect(isValidGroupNumber(701)).toBe(false);
  });

  it("should reject non-numeric strings or invalid formats", () => {
    expect(isValidGroupNumber("")).toBe(false);
    expect(isValidGroupNumber("abc")).toBe(false);
    expect(isValidGroupNumber("100a")).toBe(false);
    expect(isValidGroupNumber("100.5")).toBe(false);
  });
});

describe("SignUpValidationSchema groupNumber", () => {
  const baseSignUp = {
    email: "test@example.com",
    password: "password123",
    passwordAgain: "password123",
    telegram: "@username",
    name: "Иван",
    surname: "Иванов",
    patronymic: "Иванович",
  };

  it("validates group numbers within 100-700", () => {
    const validResult = SignUpValidationSchema.safeParse({
      ...baseSignUp,
      groupNumber: "321",
    });
    expect(validResult.success).toBe(true);
  });

  it("fails for group numbers outside 100-700", () => {
    const invalidResult = SignUpValidationSchema.safeParse({
      ...baseSignUp,
      groupNumber: "800",
    });
    expect(invalidResult.success).toBe(false);
    if (!invalidResult.success) {
      expect(invalidResult.error.issues[0].message).toBe("Номер группы должен быть числом от 100 до 700");
    }
  });
});

describe("ProfileValidationSchema group_number", () => {
  const baseProfile = {
    surname: "Иванов",
    name: "Иван",
    patronymic: "Иванович",
  };

  it("validates group numbers within 100-700", () => {
    const validResult = ProfileValidationSchema.safeParse({
      ...baseProfile,
      group_number: "201",
    });
    expect(validResult.success).toBe(true);
  });

  it("allows empty group number in profile (optional)", () => {
    const validResult = ProfileValidationSchema.safeParse({
      ...baseProfile,
      group_number: "",
    });
    expect(validResult.success).toBe(true);
  });

  it("fails for group numbers outside 100-700", () => {
    const invalidResult = ProfileValidationSchema.safeParse({
      ...baseProfile,
      group_number: "42",
    });
    expect(invalidResult.success).toBe(false);
    if (!invalidResult.success) {
      expect(invalidResult.error.issues[0].message).toBe("Номер группы должен быть числом от 100 до 700");
    }
  });
});
