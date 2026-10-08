// Hidden markers the App embeds in its GitHub comments (design §12). The publisher (Phase 9) writes them;
// context collection reads them to learn what was already posted.

const FINGERPRINT_MARKER = /<!--\s*ai-pr-review:fp=([0-9a-f]{16});sha=([0-9a-f]{7,64})\s*-->/;
const SUMMARY_MARKER = /<!--\s*ai-pr-review:summary\s*-->/;

export const SUMMARY_MARKER_TEXT = "<!-- ai-pr-review:summary -->";

export function fingerprintMarker(fingerprint: string, headSha: string): string {
  return `<!-- ai-pr-review:fp=${fingerprint};sha=${headSha} -->`;
}

export function parseFingerprintMarker(
  body: string,
): { fingerprint: string; headSha: string } | undefined {
  const match = FINGERPRINT_MARKER.exec(body);
  return match ? { fingerprint: match[1] as string, headSha: match[2] as string } : undefined;
}

export function hasSummaryMarker(body: string): boolean {
  return SUMMARY_MARKER.test(body);
}
