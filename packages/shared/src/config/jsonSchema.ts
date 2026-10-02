import { z } from "zod";
import { PRODUCT_NAME } from "../constants";
import { repoConfigSchema } from "./schema";

/**
 * JSON Schema for `.github/ai-pr-review.yml`, generated from the zod schema (single source of truth).
 * Dashboard-only keys (provider, model, base_url, limits) are deliberately absent.
 */
export function buildConfigJsonSchema(): object {
  return {
    ...z.toJSONSchema(repoConfigSchema, { io: "input" }),
    title: `${PRODUCT_NAME} repository configuration`,
  };
}
