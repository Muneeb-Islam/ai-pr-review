import type { ReactNode } from "react";
import { ExternalIcon } from "./icons";

/** A link to GitHub: opens in a new tab and says so to screen readers. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1"
    >
      {children}
      <ExternalIcon />
      <span className="sr-only">(opens GitHub in a new tab)</span>
    </a>
  );
}
