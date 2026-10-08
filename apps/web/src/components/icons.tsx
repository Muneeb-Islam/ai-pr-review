import type { ReactNode } from "react";

/** Small inline icons. Always decorative (the text next to them carries the meaning), so aria-hidden. */
function Icon({
  children,
  className = "h-3.5 w-3.5",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${className} shrink-0`}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

type IconProps = { className?: string };

export const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.5 1.5" />
  </Icon>
);
export const SpinnerIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2a6 6 0 1 0 6 6" className="origin-center motion-safe:animate-spin" />
  </Icon>
);
export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8.5l3.2 3L13 4.5" />
  </Icon>
);
export const CrossIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);
export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5l6 10.5H2z" />
    <path d="M8 6.5v3M8 11.5v.01" />
  </Icon>
);
export const SkipIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 4l5 4-5 4zM9 4l5 4-5 4z" />
  </Icon>
);
export const SwapIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 5h9l-2-2M13 11H4l2 2" />
  </Icon>
);
export const StopIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M5 11l6-6" />
  </Icon>
);
export const LockIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Icon>
);
export const GlobeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
  </Icon>
);
export const ExternalIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />
  </Icon>
);
export const SunIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
  </Icon>
);
export const MoonIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />
  </Icon>
);
export const MonitorIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="8" rx="1" />
    <path d="M6 14h4M8 11v3" />
  </Icon>
);
export const GitHubMark = ({ className = "h-4 w-4" }: IconProps) => (
  <svg
    viewBox="0 0 16 16"
    fill="currentColor"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
export const ShieldIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 1.8l5 1.8v4c0 3.1-2.1 5.3-5 6.6-2.9-1.3-5-3.5-5-6.6v-4z" />
  </Icon>
);
