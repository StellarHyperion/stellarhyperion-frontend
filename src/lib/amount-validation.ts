import { parseUnits } from "@hyperion/protocol";

export type AmountValidation = { valid: true; units: bigint } | { valid: false; message: string };

/** Validate without changing the user's text, so precision errors remain explainable. */
export function validateAmount(raw: string): AmountValidation {
  const value = raw.trim();
  if (!value) return { valid: false, message: "Enter an amount to send." };
  if (!/^\d+(?:\.\d{1,7})?$/.test(value)) {
    return { valid: false, message: "Enter a positive amount with up to 7 decimal places." };
  }
  try {
    const units = parseUnits(value, 7);
    if (units <= 0n) return { valid: false, message: "Enter an amount greater than zero." };
    if (units > (1n << 63n) - 1n)
      return { valid: false, message: "Amount exceeds Stellar's asset limit." };
    return { valid: true, units };
  } catch {
    return { valid: false, message: "Enter a valid amount." };
  }
}
