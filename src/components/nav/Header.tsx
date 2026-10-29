"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { useEffect, useSyncExternalStore, type ReactElement } from "react";

import { HyperionMark } from "../brand/HyperionMark";
import { StellarWalletButton } from "../wallet";
import styles from "../chrome/Chrome.module.css";

export type ThemeChoice = "system" | "dark" | "light";

let fallbackTheme: ThemeChoice = "system";
const themeEvent = "hyperion:theme";

function getThemeSnapshot(): ThemeChoice {
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
  return fallbackTheme;
}

function subscribeTheme(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(themeEvent, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(themeEvent, onChange);
  };
}

export function ThemeSelector(): ReactElement {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, () => "system");

  useEffect(() => {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, [theme]);

  const selectTheme = (choice: ThemeChoice) => {
    fallbackTheme = choice;
    try {
      localStorage.setItem("hyperion.theme", choice);
    } catch {
      // Ignore storage access errors
    }
    window.dispatchEvent(new Event(themeEvent));
  };

  return (
    <div className={styles.themeSelector}>
      <select
        aria-label="Color theme"
        value={theme}
        onChange={(event) => {
          const choice = event.target.value;
          if (choice === "system" || choice === "dark" || choice === "light") selectTheme(choice);
        }}
      >
        <option value="system">System</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
      <ChevronDown size={12} aria-hidden="true" />
    </div>
  );
}

export function Header({ network }: { readonly network: string }): ReactElement {
  const transfersActive = usePathname().startsWith("/transfers");
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <div className={styles.brandGroup}>
          <Link className={styles.brand} href="/">
            <HyperionMark size={26} className={styles.brandMark} label="Hyperion, home" />
            <span className={styles.brandName}>Hyperion</span>
          </Link>
          <nav
            className={styles.navLinks}
            aria-label="Main navigation"
            data-section={transfersActive ? "transfers" : "send"}
          >
            <Link
              className={styles.navLink}
              href="/"
              aria-current={!transfersActive ? "page" : undefined}
            >
              Send
            </Link>
            <Link
              className={styles.navLink}
              href="/transfers"
              aria-current={transfersActive ? "page" : undefined}
            >
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
        </div>
      </div>
    </header>
  );
}
