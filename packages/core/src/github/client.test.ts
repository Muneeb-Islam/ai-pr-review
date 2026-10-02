import { describe, expect, it } from "vitest";
import { fetchPullRequest, type GitHubClient, type PullsClient } from "./client";

describe("fetchPullRequest", () => {
  const client = (data: Awaited<ReturnType<PullsClient["request"]>>["data"]): PullsClient => ({
    request: async () => ({ data }),
  });

  it("maps API data, including fork detection", async () => {
    const info = await fetchPullRequest(
      client({
        number: 3,
        draft: true,
        base: { ref: "master", repo: { full_name: "a/b" } },
        head: { sha: "deadbeef", repo: { full_name: "c/b" } },
      }),
      { owner: "a", repo: "b" },
      3,
    );
    expect(info).toEqual({
      number: 3,
      baseRef: "master",
      headSha: "deadbeef",
      isDraft: true,
      isFork: true,
    });
  });
});

describe("client typing", () => {
  it("the real client satisfies PullsClient", () => {
    // Compile-time check: fails typecheck if the Octokit request signature drifts.
    const assertAssignable = (c: GitHubClient): PullsClient => c;
    expect(typeof assertAssignable).toBe("function");
  });
});
