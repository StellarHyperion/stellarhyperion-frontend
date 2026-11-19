import { type ReactElement } from "react";
import type { FormattedTransfer } from "../../api";
import { getEvidenceTimeline, type EvidenceStage } from "../../lib/evidence";
import styles from "./EvidenceTimeline.module.css";

interface EvidenceTimelineProps {
  readonly transfer: FormattedTransfer;
}

function evidenceLink(stage: EvidenceStage): string {
  if (stage.key === "source") return "View source proof";
  if (stage.key === "destination") return "View destination proof";
  return "View provider reference";
}

export function EvidenceTimeline({ transfer }: EvidenceTimelineProps): ReactElement {
  return (
    <section aria-label="Source and destination evidence" className={styles.timelineSection}>
      <h3 className={styles.title}>Evidence timeline</h3>
      <ol className={styles.timeline}>
        {getEvidenceTimeline(transfer).map((stage) => (
          <li key={stage.key} className={`${styles.stage} ${styles[stage.status]}`}>
            <span className={styles.marker} aria-hidden="true" />
            <div className={styles.content}>
              <div className={styles.heading}>
                <span className={styles.label}>{stage.label}</span>
                <span className={styles.status}>{stage.status}</span>
              </div>
              <span className={styles.detail}>
                {stage.detail}
                {stage.href && (
                  <>
                    {" "}
                    <a
                      className={styles.link}
                      href={stage.href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {evidenceLink(stage)}
                    </a>
                  </>
                )}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
