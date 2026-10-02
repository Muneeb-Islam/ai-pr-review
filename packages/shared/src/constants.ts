/** Placeholder name (decision 10). Rename here, in README and examples. */
export const PRODUCT_NAME = "ai-pr-review-assistant";
/** Repo-level config file, read from the base branch (design §6). */
export const REPO_CONFIG_PATH = ".github/ai-pr-review.yml";
export const COMMENT_COMMAND = "/ai-review";
/** Name of the Check Run the App creates on every reviewed pull request. */
export const CHECK_RUN_NAME = "AI PR Review";
/** Commenters allowed to start a manual review with `COMMENT_COMMAND` (GitHub `author_association`). */
export const COMMAND_ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const;
