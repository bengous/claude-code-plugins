import { describe, expect, test } from "bun:test";

import { githubSlugOf, slugOfPullRequest, slugOfRepoOption } from "./github.ts";

describe("githubSlugOf", () => {
  const cases = [
    ["git@github.com:bengous/claude-code-plugins.git", "github.com/bengous/claude-code-plugins"],
    ["https://github.com/bengous/dotfiles", "github.com/bengous/dotfiles"],
    ["https://token@github.com/o/n.git/", "github.com/o/n"],
    ["ssh://git@github.com:22/o/n.git", "github.com/o/n"],
    ["git://example.com/o/n", "example.com/o/n"],
  ] as const;

  for (const [url, slug] of cases) {
    test(`${url} is ${slug}`, () => {
      expect(githubSlugOf(url)).toBe(slug);
    });
  }

  test("a local path or a bare name is none", () => {
    expect(githubSlugOf("/srv/git/repo.git")).toBeNull();
    expect(githubSlugOf("../other")).toBeNull();
    expect(githubSlugOf("file:///srv/repo")).toBeNull();
  });

  test("a --repo value gives its repository", () => {
    expect(slugOfRepoOption("o/n")).toBe("github.com/o/n");
    expect(slugOfRepoOption("ghe.example.com/o/n")).toBe("ghe.example.com/o/n");
    expect(slugOfRepoOption("https://github.com/o/n.git")).toBe("github.com/o/n");
    expect(slugOfRepoOption("n")).toBeNull();
  });

  test("a pull request URL gives its repository", () => {
    expect(slugOfPullRequest("https://github.com/o/n/pull/12")).toBe("github.com/o/n");
    expect(slugOfPullRequest("not a url")).toBeNull();
  });
});
