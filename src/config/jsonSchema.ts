import { z } from "zod";
import { ACTION_NAME } from "../constants";
import { configSchema } from "./schema";

/** JSON Schema for `.github/ai-pr-review.yml`, generated from the zod schema (single source of truth). */
export function buildConfigJsonSchema(): object {
  return {
    ...z.toJSONSchema(configSchema, { io: "input" }),
    title: `${ACTION_NAME} configuration`,
  };
}
