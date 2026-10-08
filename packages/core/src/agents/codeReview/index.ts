import type { ChangedFile, ReviewContext } from "../../context/types";
import { CODE_REVIEW_PROMPT } from "../../prompts/codeReview.v1";
import { createLlmAgent } from "../structured";

/**
 * Files the Code Review agent reads: everything the review kept except deletions. A deleted file has no added
 * line to comment on and its diff costs tokens for little; its path is still listed in the prompt.
 */
export function selectCodeReviewFiles(context: ReviewContext): ChangedFile[] {
  return context.files.filter((file) => file.status !== "removed" && Boolean(file.patch));
}

/**
 * Code Review agent (FR-11, design §10): correctness, regressions, error handling, API contract breaks,
 * performance and maintainability. Security issues and missing tests belong to the other agents, so the
 * category list leaves them out.
 */
export const codeReviewAgent = createLlmAgent({
  id: "code_review",
  label: "Code Review",
  prompt: CODE_REVIEW_PROMPT,
  categories: ["bug", "performance", "maintainability"],
  selectFiles: selectCodeReviewFiles,
});
