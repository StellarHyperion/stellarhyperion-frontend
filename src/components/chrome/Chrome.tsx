/**
 * Header, column and footer.
 *
 * The column is the product. A transfer is a linear journey across a boundary, so the page's
 * vertical axis is the route: you read the origin leg, you reach the switchyard, you read the
 * destination leg. Nothing is in a sidebar, because nothing about a transfer happens beside it.
 *
 * The switchyard is the only thing that leaves the column, which is why `main` is a plain block
 * and the column is a child of it rather than the other way round. A full bleed element inside a
 * constrained grid has to fight its parent with negative margins and viewport units, and that
 * fight is where the horizontal scrollbar comes from.
 */
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";

import styles from "./Chrome.module.css";

export { Header } from "../nav/Header";

export function Shell({ children }: { readonly children: ReactNode }): ReactElement {
  return <div className={styles.shell}>{children}</div>;
}

export function Main({ children }: { readonly children: ReactNode }): ReactElement {
  return <main className={styles.main}>{children}</main>;
}

export function Column({
  children,
  tight = false,
}: {
  readonly children: ReactNode;
  readonly tight?: boolean;
}): ReactElement {
  return <div className={`${styles.column} ${tight ? styles.columnTight : ""}`}>{children}</div>;
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
