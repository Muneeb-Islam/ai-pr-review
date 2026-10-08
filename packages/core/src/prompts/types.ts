/**
 * A prompt is a versioned file (design §11): changing the wording means a new `version`, and the id and version
 * are logged with every agent run so behaviour can be traced to the text that produced it. The wording lives in
 * `role`, `task`, `rubric` and `output`; `composeSystemPrompt` adds the untrusted-content rule to all of them.
 */
export interface PromptDefinition {
  /** Stable name, e.g. `code_review`. */
  readonly id: string;
  /** Bumped on every change to the wording. */
  readonly version: number;
  /** Who the model is and how it behaves. */
  readonly role: string;
  /** What to look for, what to leave alone, and how to read the input. */
  readonly task: string;
  /** How to choose a severity and a confidence. */
  readonly rubric: string;
  /** What each output field means. The JSON Schema itself travels with the request. */
  readonly output: string;
  /** The first sentence of the user message, when the default ("Review the pull request diff below...") does not fit. */
  readonly intro?: string;
}
