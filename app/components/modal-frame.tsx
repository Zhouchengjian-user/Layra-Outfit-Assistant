"use client";

import { useEffect, type ReactNode } from "react";

export function ModalFrame({ children, onClose, closeDisabled = false, panelClassName = "", backdropClassName = "" }: {
  children: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  panelClassName?: string;
  backdropClassName?: string;
}) {
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closeDisabled) onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeDisabled, onClose]);

  return <div className={`modal-backdrop ${backdropClassName}`}>
    <button type="button" className="modal-backdrop-dismiss" aria-label="关闭弹窗" disabled={closeDisabled} onClick={onClose} />
    <section className={`modal ${panelClassName}`} role="dialog" aria-modal="true">{children}</section>
  </div>;
}
