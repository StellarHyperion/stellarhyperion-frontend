"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import styles from "../bridge/AssetPicker.module.css";

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
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
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
          <h2>{title}</h2>
          <button type="button" aria-label="Close selector" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </dialog>
  );
}
