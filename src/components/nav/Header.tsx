"use client";

import Link from "next/link";
import { useEffect, useState, type ReactElement } from "react";

import { HyperionMark } from "../brand/HyperionMark";
import { StellarWalletButton, EvmWalletButton } from "../wallet";
import styles from "../chrome/Chrome.module.css";

export type ThemeChoice = "system" | "dark" | "light";

function getInitialTheme(): ThemeChoice {
  if (typeof window === "undefined") {
    return "system";
  }
  try {
    const stored = localStorage.getItem("hyperion.theme");
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Ignore storage access errors
  }
  return "system";
}

export function ThemeSelector(): ReactElement {
  const [theme, setTheme] = useState<ThemeChoice>(getInitialTheme);

  useEffect(() => {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, [theme]);

  const selectTheme = (choice: ThemeChoice) => {
    setTheme(choice);
    try {
      localStorage.setItem("hyperion.theme", choice);
    } catch {
      // Ignore storage access errors
    }
  };

  return (
    <div className={styles.themeSelector} role="group" aria-label="Theme selector">
      <button
        type="button"
        className={`${styles.themeOption} ${theme === "system" ? styles.themeOptionActive : ""}`}
        onClick={() => {
          selectTheme("system");
        }}
        aria-pressed={theme === "system"}
      >
        System
      </button>
      <button
        type="button"
        className={`${styles.themeOption} ${theme === "dark" ? styles.themeOptionActive : ""}`}
        onClick={() => {
          selectTheme("dark");
        }}
        aria-pressed={theme === "dark"}
      >
        Dark
      </button>
      <button
        type="button"
        className={`${styles.themeOption} ${theme === "light" ? styles.themeOptionActive : ""}`}
        onClick={() => {
          selectTheme("light");
        }}
        aria-pressed={theme === "light"}
      >
        Light
      </button>
    </div>
  );
}

export function Header({ network }: { readonly network: string }): ReactElement {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <div className={styles.brandGroup}>
          <Link className={styles.brand} href="/">
            <HyperionMark size={26} className={styles.brandMark} label="Hyperion, home" />
            <span className={styles.brandName}>Hyperion</span>
          </Link>
          <nav className={styles.navLinks} aria-label="Main navigation">
            <Link className={styles.navLink} href="/">
              Switchyard
            </Link>
            <Link className={styles.navLink} href="/transfers">
              Transfers
            </Link>
          </nav>
        </div>
        {/*
         * Which network you are on, in mono, because getting this wrong is the expensive mistake
         * and a person should be able to read it without opening a menu.
         */}
        <div className={styles.actions}>
          <span className={`mono ${styles.network}`}>{network}</span>
          <ThemeSelector />
          <StellarWalletButton />
          <EvmWalletButton />
        </div>
      </div>
    </header>
  );
}
