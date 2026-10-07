"use client";

import type { ReactElement } from "react";
import type { RoutePlannerHook } from "./useRoutePlanner";
import styles from "./RoutePlanner.module.css";

interface RoutePlannerProps {
  readonly planner: RoutePlannerHook;
}

export function RoutePlanner({ planner }: RoutePlannerProps): ReactElement {
  const { input, setAmount, setDestinationAddress, breakdown } = planner;

  const presets = ["100", "500", "1000", "5000"];

  return (
    <section className={styles.panel} aria-label="Route pricing planner">
      <div className={styles.titleRow}>
        <h2 className={styles.title}>Route planner</h2>
        <span className={styles.statusTag}>live local pricing</span>
      </div>

      <div className={styles.grid}>
        <div className={styles.field}>
          <label htmlFor="quote-amount" className={styles.label}>
            Send amount (Stellar USDC)
          </label>
          <div className={styles.inputWrapper}>
            <input
              id="quote-amount"
              type="text"
              inputMode="decimal"
              className={styles.input}
              value={input.amount}
              onChange={(e) => {
                setAmount(e.target.value);
              }}
              placeholder="1000.00"
            />
            <span className={styles.ticker}>USDC</span>
          </div>
          <div className={styles.presets}>
            {presets.map((preset) => (
              <button
                key={preset}
                type="button"
                className={styles.presetBtn}
                onClick={() => {
                  setAmount(preset);
                }}
              >
                {Number(preset).toLocaleString()}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <label htmlFor="quote-destination" className={styles.label}>
            Recipient address (EVM or Stellar strkey)
          </label>
          <div className={styles.inputWrapper}>
            <input
              id="quote-destination"
              type="text"
              className={styles.input}
              value={input.destinationAddress}
              onChange={(e) => {
                setDestinationAddress(e.target.value);
              }}
              placeholder="0x... or G..."
            />
          </div>
        </div>
      </div>

      {breakdown && (
        <div className={styles.breakdown}>
          <div className={styles.breakdownItem}>
            <span className={styles.breakdownLabel}>router fee (0.30%)</span>
            <span className={styles.breakdownValue}>{breakdown.feeAmount}</span>
          </div>
          <div className={styles.breakdownItem}>
            <span className={styles.breakdownLabel}>effective net</span>
            <span className={styles.breakdownValue}>{breakdown.netAmount}</span>
          </div>
          <div className={styles.breakdownItem}>
            <span className={styles.breakdownLabel}>estimated arrival</span>
            <span className={`${styles.breakdownValue} ${styles.highlightValue}`}>
              {breakdown.destinationAmount}
            </span>
          </div>
          <div className={styles.breakdownItem}>
            <span className={styles.breakdownLabel}>winning rail</span>
            <span className={styles.breakdownValue}>
              {breakdown.selectedRouteLabel ?? "calculating"}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
