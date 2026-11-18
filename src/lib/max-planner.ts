import { relayBudget } from "./relay-budget";

/**
 * Conservative XLM minimum reserve to leave in the account after paying relay gas.
 * Stellar base reserve is 0.5 XLM per account plus 0.5 XLM per subentry.
 * A funded account with one USDC trustline has at least 2 subentries (account + trustline),
 * so the protocol minimum is 1.0 XLM. We hold 2.0 XLM as a conservative margin.
 * Value is in Stellar's 7-decimal stroop representation (10_000_000 = 1 XLM).
 */
export const XLM_MINIMUM_RESERVE = 20_000_000n; // 2 XLM in 7-decimal stroops

/**
 * Conservative maximum USDC amount that can be bridged, given live lane constraints and
 * wallet balances.  Returns null when a safe maximum cannot be determined because pricing
 * is unavailable or balances are insufficient.
 *
 * route 0 (CCTP): estimatedRelayGas is denominated in USDC 7-decimal.  Circle's forwarding
 * budget is deducted from the destination so the full relayBudget is subtracted from the
 * spendable USDC balance before capping against flowAvailable.
 *
 * route 1 (ITS / Axelar): estimatedRelayGas is denominated in XLM 7-decimal.  The user
 * pays it from the native XLM balance.  The function verifies XLM covers the budgeted gas
 * plus the minimum account reserve before allowing any USDC to be bridged.
 *
 * Missing pricing (estimatedRelayGas <= 0) always returns null so a falsely executable
 * maximum is never produced.
 */
export function planMaxUsdcAmount(params: {
  route: number;
  usdcSpendable: bigint;
  xlmSpendable: bigint;
  flowAvailable: bigint;
  estimatedRelayGas: bigint;
}): bigint | null {
  const { route, usdcSpendable, xlmSpendable, flowAvailable, estimatedRelayGas } = params;

  if (estimatedRelayGas <= 0n || flowAvailable <= 0n) return null;

  if (route === 1) {
    // ITS: relay gas paid from XLM balance.
    const gasBudget = relayBudget(estimatedRelayGas);
    const xlmAfterGasAndReserve = xlmSpendable - gasBudget - XLM_MINIMUM_RESERVE;
    if (xlmAfterGasAndReserve < 0n) return null;
    const cap = usdcSpendable < flowAvailable ? usdcSpendable : flowAvailable;
    return cap > 0n ? cap : null;
  }

  // CCTP (route 0): relay gas budget subtracted from USDC balance.
  const gasBudget = relayBudget(estimatedRelayGas);
  const usdcAfterRelay = usdcSpendable - gasBudget;
  if (usdcAfterRelay <= 0n) return null;
  const cap = usdcAfterRelay < flowAvailable ? usdcAfterRelay : flowAvailable;
  return cap > 0n ? cap : null;
}

/**
 * Conservative maximum source-asset amount for non-USDC inputs.
 * The source spending cap is tracked separately from the USDC output that results from
 * conversion.  Missing pricing is not required here because the user's spendable balance
 * is the binding constraint; a live conversion quote is obtained when the amount is entered.
 *
 * Returns null when the trustline blocks spending or the spendable balance is zero.
 */
export function planMaxSourceAmount(params: {
  spendableSourceUnits: bigint;
  trustlineOk: boolean;
}): bigint | null {
  if (!params.trustlineOk || params.spendableSourceUnits <= 0n) return null;
  return params.spendableSourceUnits;
}
