import { Column } from "../components/chrome";
import { Bridge, ClaimRecovery } from "../components/bridge/Bridge";
import { HyperionMark } from "../components/brand/HyperionMark";
import styles from "./page.module.css";

export default function HomePage() {
  return (
    <Column>
      <div className={styles.layout}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>
            <span /> A direct connection
          </p>
          <h1 className={styles.title}>
            Stellar.
            <br />
            <span>Meet Sepolia.</span>
          </h1>
          <p className={styles.description}>
            Send testnet USDC with your Stellar wallet. Follow it all the way to Ethereum Sepolia.
          </p>
          <div className={styles.note}>
            <span className={styles.noteMark} aria-hidden="true">
              <HyperionMark size={20} />
            </span>
            <p>
              Your wallet signs.
              <br />
              <span>Follow real confirmations.</span>
            </p>
          </div>
        </div>
        <div className={styles.composer}>
          <Bridge />
          <ClaimRecovery />
        </div>
      </div>
    </Column>
  );
}
