"use client";

import { useState, type ReactElement } from "react";
import type { RoutePlannerHook } from "./useRoutePlanner";
import styles from "./RoutePlanner.module.css";

interface RoutePlannerProps {
  readonly planner: RoutePlannerHook;
}

const SLIPPAGE_PRESETS = [
  { label: "0.1%", bps: 10 },
  { label: "0.5%", bps: 50 },
  { label: "1.0%", bps: 100 },
];

export function RoutePlanner({ planner }: RoutePlannerProps): ReactElement {
  const { input, setAmount, setDestinationAddress, setSlippageBps, breakdown } = planner;
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);
  const [customMode, setCustomMode] = useState<boolean>(false);
  const [customBpsInput, setCustomBpsInput] = useState<string>("");

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

      <div className={styles.advancedSection}>
        <button
          type="button"
          className={styles.advancedToggle}
          onClick={() => {
            setAdvancedOpen((prev) => !prev);
          }}
          aria-expanded={advancedOpen}
          aria-controls="advanced-settings-panel"
        >
          <span>Advanced settings</span>
          <span className={styles.toggleIndicator}>{advancedOpen ? "hide" : "show"}</span>
        </button>

        {advancedOpen && (
          <div id="advanced-settings-panel" className={styles.advancedPanel}>
            <div className={styles.slippageControlGroup}>
              <div className={styles.slippageHeader}>
                <span className={styles.label}>Slippage tolerance</span>
                <span className={styles.slippageCurrentNote}>
                  {(input.slippageBps / 100).toFixed(2)}% ({input.slippageBps} bps)
                </span>
              </div>

              <div className={styles.slippageOptions}>
                {SLIPPAGE_PRESETS.map((preset) => (
                  <button
                    key={preset.bps}
                    type="button"
                    className={`${styles.presetBtn} ${input.slippageBps === preset.bps && !customMode ? styles.presetBtnActive : ""}`}
                    onClick={() => {
                      setCustomMode(false);
                      setCustomBpsInput("");
                      setSlippageBps(preset.bps);
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={`${styles.presetBtn} ${customMode ? styles.presetBtnActive : ""}`}
                  onClick={() => {
                    setCustomMode(true);
                    if (!customBpsInput) {
                      setCustomBpsInput(input.slippageBps.toString());
                    }
                  }}
                >
                  custom
                </button>
              </div>

              {customMode && (
                <div className={styles.customInputRow}>
                  <div className={styles.inputWrapper}>
                    <input
                      id="custom-slippage-input"
                      type="text"
                      inputMode="numeric"
                      className={styles.input}
                      value={customBpsInput}
                      onChange={(e) => {
                        const val = e.target.value.replace(/[^\d]/g, "");
                        setCustomBpsInput(val);
                        if (val) {
                          const num = Number.parseInt(val, 10);
                          if (!Number.isNaN(num)) {
                            setSlippageBps(num);
                          }
                        }
                      }}
                      placeholder="e.g. 50"
                      aria-label="Custom basis points"
                    />
                    <span className={styles.ticker}>bps</span>
                  </div>
                </div>
              )}

              {input.slippageBps > 500 && (
                <div className={styles.warningMessage} role="alert">
                  Warning: Slippage tolerance exceeds 500 bps (5.00%). High slippage may result in
                  significant capital loss.
                </div>
              )}

              <div className={styles.minReceivedDisplay}>
                <span className={styles.minReceivedLabel}>Minimum received</span>
                <span className={styles.minReceivedValue}>
                  {breakdown ? breakdown.minAmountOut : "0.000000 USDC"}
                </span>
              </div>
            </div>
          </div>
        )}
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
            <span className={styles.breakdownLabel}>minimum received</span>
            <span className={styles.breakdownValue}>{breakdown.minAmountOut}</span>
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
