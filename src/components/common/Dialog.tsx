"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import styles from "../bridge/AssetPicker.module.css";
import { usePrefersReducedMotion } from "./motion";

export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Persistent actions. They stay outside the scroll region so they remain reachable. */
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();

    // Native modality isolates the background and handles nested dialogs.
    // Start at the review heading unless a child has explicitly requested focus.
    if (!dialog?.querySelector("[autofocus]")) heading.current?.focus();

    return () => {
      dialog?.close();
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
        if (opener?.isConnected && !opener.matches(":disabled") && !opener.closest("[inert]"))
          opener.focus();
      });
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label={title}
      data-reduced-motion={reducedMotion ? "true" : undefined}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        const dialog = event.currentTarget;
        if (
          event.key !== "Tab" ||
          !(event.target instanceof Element) ||
          event.target.closest("dialog") !== dialog
        )
          return;
        // Keep Tab at the active dialog's edges instead of entering browser chrome.
        // Parent handlers must never redirect a nested modal's keyboard navigation.
        const controls = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]',
          ),
        ).filter(
          (control) =>
            control.closest("dialog") === dialog &&
            control.tabIndex >= 0 &&
            !control.matches(":disabled") &&
            !control.closest("[inert]") &&
            control.getClientRects().length > 0 &&
            getComputedStyle(control).visibility === "visible",
        );
        const first = controls[0];
        const last = controls.at(-1);
        const active = document.activeElement;
        if (!first || !last) {
          event.preventDefault();
          heading.current?.focus();
        } else if (
          event.shiftKey &&
          (active === first || !controls.includes(active as HTMLElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.content}>
        <div className={styles.heading}>
          <h2 ref={heading} tabIndex={-1}>
            {title}
          </h2>
          <button type="button" aria-label={`Close ${title}`} onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </dialog>
  );
}
