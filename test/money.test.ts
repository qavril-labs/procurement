import { describe, expect, it } from "vitest";
import {
  formatMoney, formatQuantity, lineTotal, MoneyError, parseMoney, parseQuantity, parseRateBps, roundDiv, taxOn,
} from "../src/money.js";

describe("parseMoney and formatMoney", () => {
  it("round-trips two-decimal currencies", () => {
    expect(parseMoney("12500.5", "INR")).toBe(1250050n);
    expect(formatMoney(1250050n, "INR")).toBe("12500.50");
    expect(formatMoney(5n, "INR")).toBe("0.05");
  });

  it("handles negative amounts", () => {
    expect(parseMoney("-0.01", "INR")).toBe(-1n);
    expect(formatMoney(-1n, "INR")).toBe("-0.01");
    expect(formatMoney(-150n, "INR")).toBe("-1.50");
  });

  it("handles zero-decimal currencies", () => {
    expect(parseMoney("1500", "JPY")).toBe(1500n);
    expect(formatMoney(1500n, "JPY")).toBe("1500");
    expect(() => parseMoney("1500.5", "JPY")).toThrow(MoneyError);
  });

  it("handles three-decimal currencies", () => {
    expect(parseMoney("1.250", "KWD")).toBe(1250n);
    expect(formatMoney(1250n, "KWD")).toBe("1.250");
  });

  it("rejects extra precision and malformed input", () => {
    expect(() => parseMoney("10.001", "INR")).toThrow(MoneyError);
    expect(() => parseMoney("ten", "INR")).toThrow(MoneyError);
    expect(() => parseMoney("1e3", "INR")).toThrow(MoneyError);
    expect(() => parseMoney("10", "XYZ")).toThrow(MoneyError);
  });
});

describe("quantities", () => {
  it("parses and formats up to four decimals", () => {
    expect(parseQuantity("2.5")).toBe(25000n);
    expect(formatQuantity(25000n)).toBe("2.5");
    expect(formatQuantity(10000n)).toBe("1");
    expect(formatQuantity(12345n)).toBe("1.2345");
  });

  it("rejects negatives and more than four decimals", () => {
    expect(() => parseQuantity("-1")).toThrow(MoneyError);
    expect(() => parseQuantity("1.23456")).toThrow(MoneyError);
  });
});

describe("rounding", () => {
  it("rounds half away from zero", () => {
    expect(roundDiv(5n, 10n)).toBe(1n);
    expect(roundDiv(-5n, 10n)).toBe(-1n);
    expect(roundDiv(4n, 10n)).toBe(0n);
    expect(roundDiv(-4n, 10n)).toBe(0n);
  });

  it("rounds a half-paisa line total up", () => {
    // 0.5 units at 1.01 INR (101 paise) = 50.5 paise, rounds to 51
    expect(lineTotal(5000n, 101n)).toBe(51n);
  });

  it("keeps whole-unit line totals exact", () => {
    // 3 units at 999.99 INR
    expect(lineTotal(30000n, 99999n)).toBe(299997n);
  });

  it("computes tax in basis points with half-up rounding", () => {
    expect(parseRateBps("18")).toBe(1800n);
    expect(parseRateBps("5.5")).toBe(550n);
    // 18% of 0.05 INR (5 paise) = 0.9 paise, rounds to 1 paisa
    expect(taxOn(5n, 1800n)).toBe(1n);
    // 18% of 10.00 INR = 1.80 INR
    expect(taxOn(1000n, 1800n)).toBe(180n);
  });

  it("rejects an invalid rate", () => {
    expect(() => parseRateBps("18.005")).toThrow(MoneyError);
    expect(() => parseRateBps("-5")).toThrow(MoneyError);
  });
});
