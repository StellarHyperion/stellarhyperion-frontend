"use client";

import type { ReactElement } from "react";
import styles from "./StageLamps.module.css";

export type StageState = "idle" | "active" | "completed" | "failed";

export interface Stage {
  readonly id: string;
  readonly name: string;
  readonly detail?: string;
  readonly state: StageState;
}

interface StageLampsProps {
  readonly stages: readonly Stage[];
  readonly currentStageId?: string;
}

export function StageLamps({ stages }: StageLampsProps): ReactElement {
  return (
    <div className={styles.container} role="status" aria-label="Transfer stage progress">
      <span className={styles.heading}>transfer progression</span>
      <div className={styles.stagesList}>
        {stages.map((stage, idx) => {
          const isLast = idx === stages.length - 1;
          const lampClass =
            stage.state === "completed"
              ? styles.lampCompleted
              : stage.state === "active"
                ? styles.lampActive
                : stage.state === "failed"
                  ? styles.lampFailed
                  : styles.lampIdle;

          return (
            <div key={stage.id} className={styles.stageItem}>
              <span className={`${styles.lamp} ${lampClass}`} aria-hidden="true" />
              <div>
                <span className={styles.stageName}>{stage.name}</span>
                {stage.detail && <span className={styles.stageDetail}> ({stage.detail})</span>}
              </div>
              {!isLast && <span className={styles.connector} aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
