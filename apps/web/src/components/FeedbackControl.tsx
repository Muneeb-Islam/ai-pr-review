import { useState } from "react";
import { describeError } from "./States";
import { useGiveFeedback, type FeedbackSummary, type FeedbackVerdict } from "../hooks/insights";
import { FEEDBACK_LABELS } from "../lib/format";

const VERDICTS: FeedbackVerdict[] = ["useful", "false_positive", "known"];

/** "2 useful · 1 false positive": how people rated a finding, in words (nothing for a finding nobody rated). */
export function feedbackText(feedback: FeedbackSummary): string {
  const parts = VERDICTS.filter((v) => feedback[v] > 0).map(
    (v) => `${feedback[v]} ${(FEEDBACK_LABELS[v] ?? v).toLowerCase()}`,
  );
  return parts.join(" · ");
}

/**
 * Feedback on one finding (UI-05, AC-19): useful, a false positive or already known, with an optional note. One
 * vote per person; choosing again replaces it. The totals show who agrees. Saved as soon as a verdict is chosen;
 * the note is saved with the verdict, so adding a note re-sends the current verdict.
 */
export function FeedbackControl({
  findingId,
  feedback,
  compact = false,
}: {
  findingId: string;
  feedback: FeedbackSummary;
  compact?: boolean;
}) {
  const give = useGiveFeedback(findingId);
  const mine = feedback.mine;
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(mine?.note ?? "");
  const totals = feedbackText(feedback);

  const send = (verdict: FeedbackVerdict, withNote: string) =>
    give.mutate({ verdict, ...(withNote.trim() ? { note: withNote.trim() } : {}) });

  return (
    <div data-testid="feedback" className="space-y-2">
      <div
        role="group"
        aria-label="Was this finding useful?"
        className="flex flex-wrap items-center gap-2"
      >
        {VERDICTS.map((verdict) => (
          <button
            key={verdict}
            type="button"
            aria-pressed={mine?.verdict === verdict}
            disabled={give.isPending}
            className={`rounded border px-2 py-1 text-xs font-medium ${
              mine?.verdict === verdict
                ? "bg-accent text-accent-fg border-accent"
                : "border-border bg-surface hover:bg-surface-2"
            }`}
            onClick={() => send(verdict, note)}
          >
            {FEEDBACK_LABELS[verdict]}
          </button>
        ))}
        {!compact || mine ? (
          <button
            type="button"
            className="text-xs underline"
            aria-expanded={noteOpen}
            onClick={() => setNoteOpen((open) => !open)}
          >
            {mine?.note ? "Edit note" : "Add a note"}
          </button>
        ) : null}
        <span aria-live="polite" className="text-muted text-xs">
          {give.isPending
            ? "Saving…"
            : give.isSuccess
              ? `Saved${totals ? ` · ${totals}` : ""}`
              : totals}
        </span>
      </div>
      {noteOpen ? (
        <div>
          <label htmlFor={`note-${findingId}`} className="label">
            Note (optional, kept with your vote)
          </label>
          <textarea
            id={`note-${findingId}`}
            className="field w-full max-w-xl"
            rows={2}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            type="button"
            className="btn mt-2"
            disabled={!mine || give.isPending}
            onClick={() => mine && send(mine.verdict, note)}
          >
            Save note
          </button>
          {!mine ? <p className="text-muted mt-1 text-xs">Choose a verdict first.</p> : null}
        </div>
      ) : null}
      {give.isError ? (
        <p role="alert" className="text-danger text-xs">
          {describeError(give.error)}
        </p>
      ) : null}
    </div>
  );
}
