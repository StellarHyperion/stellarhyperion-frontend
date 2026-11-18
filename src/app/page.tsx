import { Column } from "../components/chrome";
import { Bridge, ClaimRecovery } from "../components/bridge/Bridge";
import styles from "./page.module.css";

export default function HomePage() {
  return (
    <Column>
      <div className={styles.layout}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>
            <span />
            THE ROUTING LAYER
          </p>
          <h1>
            Your assets. <span>New horizons.</span>
          </h1>
          <p>
            From Stellar to your next chain.
            <br className={styles.mobileBreak} /> One clear route, every step in view.
          </p>
        </div>
        <div className={styles.composer}>
          <Bridge />
          <ClaimRecovery />
        </div>
        <p className={styles.footnote}>Connect. Review. Sign. Follow your transfer.</p>
      </div>
    </Column>
  );
}
