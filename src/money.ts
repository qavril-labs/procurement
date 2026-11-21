// Money and quantity arithmetic. Amounts are integer minor units (bigint); quantities are
// integers scaled by 10^4. Nothing here uses floats. Rounding is half away from zero.
// Serialized amounts are decimal strings (CLAUDE.md conventions).

const CURRENCY_DIGITS: Record<string, number> = { INR: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0, KWD: 3 };

export class MoneyError extends Error {
  readonly code = "VALIDATION";
}

export function minorDigits(currency: string): number {
  const digits = CURRENCY_DIGITS[currency];
  if (digits === undefined) throw new MoneyError(`unsupported currency ${currency}`);
  return digits;
}

/** Parses a decimal string such as "12500.5" into minor units. Rejects extra precision. */
export function parseMoney(value: string, currency: string): bigint {
  const digits = minorDigits(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new MoneyError(`invalid amount ${value}`);
  const [, sign, whole, frac = ""] = match;
  if (frac.length > digits) throw new MoneyError(`${value} has more than ${digits} decimals for ${currency}`);
  const padded = frac.padEnd(digits, "0");
  const minor = BigInt(whole + padded);
  return sign === "-" ? -minor : minor;
}

export function formatMoney(minor: bigint, currency: string): string {
  const digits = minorDigits(currency);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const text = digits === 0 ? abs.toString() : abs.toString().padStart(digits + 1, "0");
  const out = digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  return negative ? `-${out}` : out;
}

/** Parses a quantity such as "10" or "2.5" into units scaled by 10^4. Non-negative. */
export function parseQuantity(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value);
  if (!match) throw new MoneyError(`invalid quantity ${value}`);
  const [, whole, frac = ""] = match;
  return BigInt(whole + frac.padEnd(4, "0"));
}

export function formatQuantity(scaled: bigint): string {
  const whole = scaled / 10000n;
  const frac = (scaled % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Divides and rounds half away from zero. */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError("division by zero");
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (2n * d);
  return negative ? -q : q;
}

/** Parses a percentage such as "18" or "5.5" into basis points (1/100 of a percent). */
export function parseRateBps(value: string): bigint {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new MoneyError(`invalid tax rate ${value}`);
  const [, whole, frac = ""] = match;
  return BigInt(whole + frac.padEnd(2, "0"));
}

/** Line total in minor units: quantity (scaled 10^4) times unit price (minor units), rounded. */
export function lineTotal(quantityScaled: bigint, unitPriceMinor: bigint): bigint {
  return roundDiv(quantityScaled * unitPriceMinor, 10000n);
}

/** Tax on an amount for a rate in basis points, rounded half away from zero. */
export function taxOn(amountMinor: bigint, rateBps: bigint): bigint {
  return roundDiv(amountMinor * rateBps, 10000n);
}

/** Formats basis points as a percentage string with two decimals, for example 1800 -> "18.00". */
export function formatRate(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}
