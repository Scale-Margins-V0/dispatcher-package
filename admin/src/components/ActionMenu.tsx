import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontalIcon } from "../icons";

type ActionMenuProps = {
  children: ReactNode;
  label?: string;
};

/** Compact row actions that keep operational tables scannable. */
export default function ActionMenu({ children, label = "More actions" }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <div className="action-menu" ref={root}>
    <button type="button" className="action-menu-trigger" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen((value) => !value)}><MoreHorizontalIcon /></button>
    {open && <div className="action-menu-popover" role="menu" onClick={() => setOpen(false)}>{children}</div>}
  </div>;
}
