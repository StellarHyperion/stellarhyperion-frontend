import Link from "next/link";
import type { ReactElement, ReactNode } from "react";

import styles from "./Chrome.module.css";

export { Header } from "../nav/Header";

export function Shell({ children }: { readonly children: ReactNode }): ReactElement {
  return <div className={styles.shell}>{children}</div>;
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
        <p className="mono">Built by dotmantissa</p>
        <nav className={styles.footerLinks} aria-label="Project links">
          <Link className="mono" href="/transfers">
            Transfers
          </Link>
          <a className="mono" href="https://github.com/StellarHyperion/stellarhyperion-contracts">
            Contracts
          </a>
          <a className="mono" href="https://github.com/StellarHyperion/stellarhyperion-backend">
            Backend
          </a>
          <a className="mono" href="https://github.com/StellarHyperion/stellarhyperion-frontend">
            This app
          </a>
        </nav>
      </div>
    </footer>
  );
}
