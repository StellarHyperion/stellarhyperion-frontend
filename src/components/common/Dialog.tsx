"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import styles from "../bridge/AssetPicker.module.css";

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();

    // Native modal focus isolation handles nested dialogs and hidden controls.
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
      onCancel={(event) => {
        event.preventDefault();
        onClose();
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
        {children}
      </div>
    </dialog>
  );
}
