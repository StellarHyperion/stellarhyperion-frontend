import type { ReactElement } from "react";

import { Column, Footer, Header, Main, Shell } from "../components/chrome/index";
import { RouteLeg } from "../components/leg/index";
import { Switchyard } from "../components/switchyard/index";
import { DESTINATION_LEG, ORIGIN_LEG, TRACKS } from "./_fixtures/yard";
import styles from "./page.module.css";

/**
 * The landing page, laid out as the thing it describes.
 *
 * Origin leg, switchyard, destination leg, read top to bottom. A transfer is a linear journey
 * across a boundary and the page's vertical axis is that journey, which is why there is no
 * dashboard split and nothing in a sidebar. Nothing about a transfer happens beside it.
 */
export default function HomePage(): ReactElement {
  return (
    <Shell>
      <Header network="stellar testnet" />
      <Main>
        <Column>
          <div className={styles.opening}>
            <h1 className="display">Four rails. One of them is right.</h1>
            <p className={`lede ${styles.claim}`}>
              Hyperion moves money between Stellar and the EVM chains without ever deciding for
              itself that a cross-chain message is real. It prices four rails that already made that
              decision and were audited for it, takes the one that lands the most, and tells you
              what the other three would have cost you.
            </p>
            <p className="prose">
              That is a smaller promise than most bridges make, and it is the reason this one is
              worth using. The trust you are extending is Circle&apos;s, or Axelar&apos;s validator
              set&apos;s, or Allbridge&apos;s pool. It is never ours. We hold the bookkeeping, the
              limits and the fee, and we are honest about which of those three is taking your money.
            </p>
          </div>

          <RouteLeg
            side="origin"
            chain="Stellar"
            meta="origin leg"
            summary="The leg you control. A ledger closes every five seconds and finality means finality, so once a departure is in a ledger there is nothing left to wait out. Seven decimal places, which is one more than USDC carries on every EVM chain, and that mismatch is checked rather than rounded away."
            facts={[
              { label: "finality", value: "5s, deterministic" },
              { label: "precision", value: "7 decimals" },
              { label: "router", value: "CDMOLDF4...ZOZ5LWCWF" },
              { label: "flow window", value: "720 ledgers" },
            ]}
          />
        </Column>

        <Switchyard
          origin={ORIGIN_LEG}
          destination={DESTINATION_LEG}
          tracks={TRACKS}
          state="resolved"
          resolutionId="layout"
        />

        <Column>
          <RouteLeg
            side="destination"
            chain="Arc"
            meta="destination leg"
            summary="The leg you wait on, except here you mostly do not. Arc settles deterministically in one confirmation and charges gas in USDC, which removes the usual problem of needing a second asset you do not have to move the first one. Six decimals on the token and eighteen on the gas accounting, and conflating those two is a mistake worth a factor of a million."
            facts={[
              { label: "confirmations", value: "1" },
              { label: "gas token", value: "USDC" },
              { label: "precision", value: "6 decimals" },
              { label: "cctp domain", value: "26" },
            ]}
          />

          <div className={styles.opening}>
            <h2 className="heading">What is actually deployed</h2>
            <p className="prose">
              The Stellar half is live on testnet and verified against its own deployment record,
              which is a file in the contracts repository that a loader validates rather than casts.
              No CCTP adapter yet: Circle deploys those contracts per network and does not publish a
              fixed address list, so the router refuses that rail by name instead of pointing at an
              address somebody guessed.
            </p>
          </div>

          <dl className={styles.deployment}>
            <div className={styles.deploymentRow}>
              <dt className={`mono ${styles.deploymentLabel}`}>router</dt>
              <dd className={`mono ${styles.deploymentValue}`}>
                CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF
              </dd>
            </div>
            <div className={styles.deploymentRow}>
              <dt className={`mono ${styles.deploymentLabel}`}>axelar its</dt>
              <dd className={`mono ${styles.deploymentValue}`}>
                CBK3TPRQR5A3H2AWESOUX4MVYOP63VNQ5EYHCX26EEJUC5B5FLB4DV5O
              </dd>
            </div>
            <div className={styles.deploymentRow}>
              <dt className={`mono ${styles.deploymentLabel}`}>usdc</dt>
              <dd className={`mono ${styles.deploymentValue}`}>
                CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
              </dd>
            </div>
          </dl>

          <p className={`monoSm ${styles.fixtureNote}`}>
            The switchyard above is laid out against a fixture while the live quote path is wired
            up. The addresses in this list are real.
          </p>
        </Column>
      </Main>
      <Footer />
    </Shell>
  );
}
