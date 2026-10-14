import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

const POPOVER_WIDTH = 240;

/**
 * A small "?" info icon. Tap it to reveal the wordy, accurate, technical detail
 * behind a casual one-liner — so the surface copy can stay short and human while
 * the precise explanation is one tap away for anyone curious.
 *
 * With a custom `trigger` it is also hover-enabled, and there hover PEEKS while
 * click PINS — they cannot both be toggles. A tap on a hover-enabled element does
 * not arrive as a bare click: browsers emulate the mouse, so one tap fires
 * mouseover, MOUSEENTER, mousedown, mouseup and CLICK in that order. Under
 * open-on-enter + toggle-on-click that resolves to open-then-close, and the
 * popover flashes and vanishes on precisely the touch devices most of this is
 * played on.
 *
 * The popover is portaled and position:fixed so it escapes `overflow-hidden`
 * cards, and is mounted inside the nearest `.dark` ancestor so Tailwind's
 * `dark:` variants resolve correctly (the dark class lives on the app root, not
 * on <body>). Closes on outside tap, scroll, resize, or Escape.
 */
export function InfoTip({ children, label = 'More info', trigger, onActivate, triggerClassName }: { children: React.ReactNode; label?: string; trigger?: React.ReactNode; onActivate?: () => void; triggerClassName?: string }) {
  const hoverable = trigger != null; // custom trigger (e.g. a badge) opens on hover too
  const [open, setOpen] = useState(false);
  /// Opened deliberately (click/tap) rather than by passing the pointer over it.
  /// A pinned popover ignores mouseleave and needs a real dismissal.
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const margin = 8;
      let left = b.left + b.width / 2 - POPOVER_WIDTH / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - POPOVER_WIDTH - margin));
      setPos({ top: b.bottom + 6, left });
    };
    place();

    const close = () => { setOpen(false); setPinned(false); };
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const dismiss = close;

    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  const portalTarget = btnRef.current?.closest('.dark') ?? (typeof document !== 'undefined' ? document.body : null);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (onActivate) { onActivate(); return; }
          // Pin if it is not already pinned — including when hover (or a tap's
          // emulated hover) has it merely peeking. Only a pinned popover closes
          // on click, so tap-to-open cannot cancel itself.
          if (pinned) { setOpen(false); setPinned(false); } else { setOpen(true); setPinned(true); }
        }}
        onMouseEnter={hoverable ? () => { if (!pinned) setOpen(true); } : undefined}
        onMouseLeave={hoverable ? () => { if (!pinned) setOpen(false); } : undefined}
        className={hoverable
          ? (triggerClassName ?? 'inline-flex items-center align-middle p-0 m-0 bg-transparent border-0 cursor-help')
          : `inline-flex items-center justify-center align-middle w-[15px] h-[15px] rounded-full
             text-[10px] font-bold leading-none normal-case select-none align-text-bottom
             bg-gray-200 text-gray-500 hover:bg-gray-300
             dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 transition-colors`}
      >
        {trigger ?? '?'}
      </button>
      {open && pos && portalTarget && createPortal(
        <div
          ref={popRef}
          role="tooltip"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
          className="z-50 rounded-lg p-3 shadow-xl normal-case text-left
                     border border-gray-200 dark:border-gray-600
                     bg-white dark:bg-gray-800
                     text-xs font-normal leading-relaxed text-gray-600 dark:text-gray-300"
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>,
        portalTarget,
      )}
    </>
  );
}
