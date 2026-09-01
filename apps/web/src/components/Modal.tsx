// apps/web/src/components/Modal.tsx
// A modal built on <dialog>, so the browser owns what a modal is: the focus
// trap, the inert page behind it, Escape, and the top layer. Nothing here
// re-implements any of that.
//
// The dialog's lifetime is the caller's state — it is mounted while open —
// so this never lets the browser close it on its own. Escape is intercepted
// and reported as onClose instead.
//
// Focus is handed back by hand. The browser restores it when a dialog in the
// document closes, but by the time an unmount cleanup runs React has already
// detached the node, so close() there restores nothing and focus falls to
// <body>. The opener is captured on open and re-focused on unmount instead —
// or, when what the dialog did removed the opener, `returnFocus`.
//
// The caller fills the body. Modal.css styles three classes for it to use:
// .modal-form (the column), .modal-body (the scrolling part), .modal-foot
// (the actions), plus [data-autofocus] to name where focus should land.
import { type ReactNode, type RefObject, useEffect, useId, useRef } from "react";
import "./Modal.css";

export function Modal({
  title,
  description,
  dismissible = true,
  returnFocus,
  onClose,
  children,
}: {
  title: string;
  /** One line under the title: what creating this actually does. */
  description?: ReactNode;
  /** False while the dialog owns something in flight — Escape and the
   *  backdrop stop dismissing it, so a request can't lose its own result. */
  dismissible?: boolean;
  /** Where focus goes when the opener didn't survive what the dialog did —
   *  a list's empty state, say, is replaced by the first row it creates. A
   *  ref because the caller has no node to give at render time. */
  returnFocus?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Tracks whether the press that a click completes STARTED on the backdrop.
  // A selection dragged out of a field ends there too, and that isn't a
  // click on the backdrop.
  const fromBackdrop = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Read before showModal() moves it: this is the button that was clicked.
    const opener = document.activeElement;
    // Read here rather than in the cleanup, where a ref's current value is
    // no longer the one this effect was set up against. Nothing a dialog
    // does re-mounts the node a caller nominated to outlive it, so the two
    // are the same one — and isConnected below covers it if they aren't.
    const fallback = returnFocus?.current;
    // StrictMode runs this twice, and showModal() throws on an open dialog.
    if (!dialog.open) dialog.showModal();
    // showModal() otherwise focuses the first focusable descendant, which is
    // whatever the layout happens to put first.
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      dialog.close();
      // isConnected, because the opener may be what the dialog replaced: an
      // empty state's Create button is gone once the row it created is on
      // the list. Focus a node no longer in the document and it lands on
      // <body> anyway, so fall back to whatever the caller kept standing.
      const back = opener instanceof HTMLElement && opener.isConnected ? opener : fallback;
      if (back?.isConnected) back.focus();
    };
    // A ref's identity is stable, so this never re-runs; it is in the deps
    // because the effect reads the prop, not because the prop can change.
  }, [returnFocus]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape. Closing is the caller's to do, so this only reports it.
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onPointerDown={(event) => {
        fromBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // The panel covers the dialog's whole content box, so the dialog
        // itself is only ever the target of a click on its ::backdrop.
        if (dismissible && fromBackdrop.current && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal-panel">
        <header className="modal-head">
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
          {description ? <p className="modal-desc">{description}</p> : null}
        </header>
        {children}
      </div>
    </dialog>
  );
}
