import Link from "next/link";
import type { ReactElement, ReactNode } from "react";

import styles from "./Chrome.module.css";
import { AmbientRoutes } from "./AmbientRoutes";

export { Header } from "../nav/Header";

export function Shell({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className={styles.shell}>
      <AmbientRoutes />
      {children}
    </div>
  );
}

export function Main({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <main id="main-content" tabIndex={-1} className={styles.main}>
      {children}
    </main>
  );
}

export function Column({ children }: { readonly children: ReactNode }): ReactElement {
  return <div className={styles.column}>{children}</div>;
}

export function Footer(): ReactElement {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <p>Testnet assets. Real confirmations.</p>
        <nav className={styles.footerLinks} aria-label="Helpful links">
          <Link className="mono" href="/transfers">
            Transfer activity
          </Link>
          <Link href="/#claim-recovery">Recover a claim</Link>
        </nav>
      </div>
    </footer>
  );
}
