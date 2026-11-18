import { describe, expect, test } from "bun:test";

import { isBranch, isLogin, isRepo, isRoutineId, render } from "./render.ts";
import { readTemplates } from "./templates.ts";

const PARAMS = {
  OWNER: "octo-cat",
  REPO: "octo-org/widgets",
  ROUTINE_ID: "trig_01AbC",
  BRANCH: "trunk",
};

describe("render", () => {
  test("replaces every parameter and leaves GitHub expressions alone", () => {
    const result = render(
      [{ path: "a.yml", content: "if: x == '{{OWNER}}'\nrepo: {{REPO}} ${{ github.token }}\n" }],
      PARAMS,
    );

    expect(result).toEqual({
      kind: "rendered",
      files: [
        {
          path: "a.yml",
          content: "if: x == 'octo-cat'\nrepo: octo-org/widgets ${{ github.token }}\n",
        },
      ],
    });
  });

  test("refuses a missing parameter, a malformed one, and an unknown placeholder, all at once", () => {
    const result = render([{ path: "b.md", content: "{{OWNER}} {{TAG}} {{ROUTINE_ID}}" }], {
      OWNER: "-bad",
      REPO: "no-slash",
    });

    expect(result).toEqual({
      kind: "refused",
      errors: [
        "b.md names an unknown parameter {{TAG}}",
        'OWNER is not a GitHub login: "-bad"',
        'REPO is not owner/name: "no-slash"',
        "ROUTINE_ID is missing",
      ],
    });
  });

  test("needs only the parameters the templates name", () => {
    expect(render([{ path: "p.md", content: "{{REPO}}" }], { REPO: "o/r" })).toEqual({
      kind: "rendered",
      files: [{ path: "p.md", content: "o/r" }],
    });
  });

  test("renders the shipped templates with no placeholder left", () => {
    const result = render(readTemplates(), PARAMS);

    if (result.kind !== "rendered") throw new Error(result.errors.join("\n"));

    for (const file of result.files) expect(file.content).not.toMatch(/\{\{[A-Z_]+\}\}/u);

    const dispatch = result.files.find(
      (file) => file.path === "repo/.github/workflows/dispatch.yml",
    );

    expect(dispatch?.content).toContain("/routines/trig_01AbC/fire");
    expect(dispatch?.content).toContain("github.event.issue.user.login == 'octo-cat'");

    const prompt = result.files.find((file) => file.path === "routine/prompt.md");

    expect(prompt?.content).toContain("Open a pull request against `trunk`");
  });
});

describe("parameter shapes", () => {
  test.each(["bengous", "a", "octo-cat", "A1-b2", "x".repeat(39)])("login %p", (value) => {
    expect(isLogin(value)).toBe(true);
  });

  test.each(["", "-a", "a-", "a--b", "a_b", "a/b", "x".repeat(40)])("not a login %p", (value) => {
    expect(isLogin(value)).toBe(false);
  });

  test.each(["bengous-labs/factory-native-trial", "a/b.c", "a/.github"])("repo %p", (value) => {
    expect(isRepo(value)).toBe(true);
  });

  test.each(["a", "a/", "/b", "a/b/c", "a/..", "a/b c", "-a/b"])("not a repo %p", (value) => {
    expect(isRepo(value)).toBe(false);
  });

  test.each(["trig_01VEa81kzaZkzqYbPVQQYP2i"])("routine id %p", (value) => {
    expect(isRoutineId(value)).toBe(true);
  });

  test.each(["trig_", "01VEa", "trig_01-x", "trig_01/fire", "env_011CU"])(
    "not a routine id %p",
    (value) => {
      expect(isRoutineId(value)).toBe(false);
    },
  );

  test.each(["main", "dev", "release/1.2", "feature/x-y_z", "v1.0"])("branch %p", (value) => {
    expect(isBranch(value)).toBe(true);
  });

  test.each([
    "",
    "@",
    "-x",
    "a..b",
    "a b",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[b",
    "a\\b",
    "a@{1}",
    "/a",
    "a/",
    "a//b",
    ".a",
    "a/.b",
    "a.",
    "a.lock",
    "a/b.lock/c",
  ])("not a branch %p", (value) => {
    expect(isBranch(value)).toBe(false);
  });
});
