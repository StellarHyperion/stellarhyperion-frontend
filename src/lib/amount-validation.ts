import { parseUnits } from "@hyperion/protocol";
import { formatMessage, type TranslationCatalog } from "./messages";

export type AmountValidation = { valid: true; units: bigint } | { valid: false; message: string };

/** Validate without changing the user's text, so precision errors remain explainable. */
export function validateAmount(raw: string, translations?: TranslationCatalog): AmountValidation {
  const value = raw.trim();
  if (!value) return { valid: false, message: formatMessage(translations, "amountPrompt") };
  if (!/^\d+(?:\.\d{1,7})?$/.test(value)) {
    return { valid: false, message: formatMessage(translations, "amountPrecision") };
  }
  try {
    const units = parseUnits(value, 7);
    if (units <= 0n)
      return { valid: false, message: formatMessage(translations, "amountPositive") };
    if (units > (1n << 63n) - 1n)
      return { valid: false, message: formatMessage(translations, "amountLimit") };
    return { valid: true, units };
  } catch {
    return { valid: false, message: formatMessage(translations, "amountInvalid") };
  }
}
