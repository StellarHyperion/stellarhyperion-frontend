"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Moon, Sun } from "lucide-react";
import { useEffect, useSyncExternalStore, type ReactElement } from "react";

import { HyperionMark } from "../brand/HyperionMark";
import { StellarWalletButton } from "../wallet";
import styles from "../chrome/Chrome.module.css";

export type ThemeChoice = "system" | "dark" | "light";

let transientTheme: ThemeChoice | null = null;
const themeEvent = "hyperion:theme";

function getThemeSnapshot(): ThemeChoice {
  if (typeof window === "undefined") {
    return "system";
  }
  if (transientTheme) return transientTheme;
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

function subscribeTheme(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(themeEvent, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(themeEvent, onChange);
  };
}

function subscribeSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

export function ThemeSelector(): ReactElement {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, () => "system");
  const systemDark = useSyncExternalStore(
    subscribeSystemTheme,
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => true,
  );
  const dark = theme === "system" ? systemDark : theme === "dark";

  useEffect(() => {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, [theme]);

  const selectTheme = (choice: ThemeChoice) => {
    const root = document.documentElement;
    try {
      localStorage.setItem("hyperion.theme", choice);
      transientTheme = null;
    } catch {
      transientTheme = choice;
    }
    const apply = () => {
      root.classList.add("themeChanging");
      root.setAttribute("data-theme", choice);
      window.dispatchEvent(new Event(themeEvent));
    };
    const clear = () => {
      root.classList.remove("themeChanging");
    };
    const start = (document as { startViewTransition?: Document["startViewTransition"] })
      .startViewTransition;
    if (start && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      void start.call(document, apply).finished.then(clear, clear);
    } else {
      apply();
      requestAnimationFrame(() => {
        requestAnimationFrame(clear);
      });
    }
  };

  return (
    <button
      type="button"
      className={styles.themeToggle}
      aria-label="Toggle dark theme"
      aria-pressed={dark}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => {
        selectTheme(dark ? "light" : "dark");
      }}
    >
      {dark ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    </button>
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
              Bridge
            </Link>
            <Link
              className={styles.navLink}
              href="/transfers"
              aria-current={transfersActive ? "page" : undefined}
            >
              Activity
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
