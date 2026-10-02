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

import { HyperionMark } from "../brand/HyperionMark";
import styles from "./Chrome.module.css";

export function Shell({ children }: { readonly children: ReactNode }): ReactElement {
  return <div className={styles.shell}>{children}</div>;
}

export function Header({ network }: { readonly network: string }): ReactElement {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link className={styles.brand} href="/">
          <HyperionMark size={26} className={styles.brandMark} label="Hyperion, home" />
          <span className={styles.brandName}>Hyperion</span>
        </Link>
        {/*
         * Which network you are on, in mono, because getting this wrong is the expensive mistake
         * and a person should be able to read it without opening a menu.
         */}
        <span className={`mono ${styles.network}`}>{network}</span>
      </div>
    </header>
  );
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
