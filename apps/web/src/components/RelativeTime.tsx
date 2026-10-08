import { formatExact, formatRelative } from "../lib/format";
import { useNow } from "../lib/ticker";

/** "5 minutes ago", with the exact local time on hover and in the machine-readable `datetime`. */
export function RelativeTime({ iso }: { iso: string }) {
  const now = useNow();
  return (
    <time dateTime={iso} title={formatExact(iso)}>
      {formatRelative(iso, now)}
    </time>
  );
}
