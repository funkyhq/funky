// apps/web/src/components/Icons.tsx
// Hand-rolled 24-grid stroke icons so the shell stays dependency-free.
// Every icon takes SVGProps, so callers can resize with width/height.
import type { SVGProps } from "react";

function Stroke({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Quick Start — a bolt. */
export function BoltIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Stroke {...props}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    </Stroke>
  );
}

/** Agent — the thing that runs the loop. */
export function AgentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Stroke {...props}>
      <path d="M12 7.5V4.8" />
      <circle cx="12" cy="3.2" r="1.2" />
      <rect x="4" y="7.5" width="16" height="12.5" rx="3.2" />
      <path d="M2 14h2M20 14h2M9.2 13.2v1.6M14.8 13.2v1.6" />
    </Stroke>
  );
}

/** Environment — the sandbox recipe, as a box. */
export function EnvironmentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Stroke {...props}>
      <path d="M11 2.7 3.6 6.6a1.9 1.9 0 0 0-1 1.7v7.4a1.9 1.9 0 0 0 1 1.7l7.4 3.9a2 2 0 0 0 2 0l7.4-3.9a1.9 1.9 0 0 0 1-1.7V8.3a1.9 1.9 0 0 0-1-1.7L13 2.7a2 2 0 0 0-2 0Z" />
      <path d="M3.2 7.2 12 12l8.8-4.8" />
      <path d="M12 12v9.6" />
    </Stroke>
  );
}

/** Session — a conversation backed by a durable log. */
export function SessionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Stroke {...props}>
      <path d="M20 4.5H4A1.5 1.5 0 0 0 2.5 6v9A1.5 1.5 0 0 0 4 16.5h3v4l4.6-4H20A1.5 1.5 0 0 0 21.5 15V6A1.5 1.5 0 0 0 20 4.5Z" />
      <path d="M6.8 9h10.4M6.8 12.4h6" />
    </Stroke>
  );
}

/** Reload a list. */
export function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Stroke width={15} height={15} {...props}>
      <path d="M20.5 12A8.5 8.5 0 1 1 18 6" />
      <path d="M21.5 2.5V6H18" />
    </Stroke>
  );
}

/** Create — the one action that adds a row to a list. */
export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Stroke width={15} height={15} {...props}>
      <path d="M12 5v14M5 12h14" />
    </Stroke>
  );
}

/** The affordance on a <select>, which draws no arrow of its own once its
 *  native appearance is dropped for the shared control styling. */
export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Stroke width={14} height={14} {...props}>
      <path d="M5.5 9 12 15.5 18.5 9" />
    </Stroke>
  );
}

/** Back to the list a detail page was opened from. */
export function ArrowLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Stroke width={15} height={15} {...props}>
      <path d="M19 12H5" />
      <path d="M11 6 5 12l6 6" />
    </Stroke>
  );
}

/** Send the composed message. */
export function SendIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Stroke width={15} height={15} {...props}>
      <path d="M4.5 12 20 4.5 15.5 20l-3.4-6.1L4.5 12Z" />
    </Stroke>
  );
}

/** Topbar docs link. */
export function ExternalLinkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Stroke width={15} height={15} {...props}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6h4.5" />
    </Stroke>
  );
}
