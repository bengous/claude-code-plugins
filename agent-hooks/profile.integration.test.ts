import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync } from "node:fs";

import { configPath } from "./config.ts";
import type { ProfileKeys } from "./profile.ts";
import { loadProfile, parseProfile } from "./profile.ts";
import type { TempRepo } from "./test-support.ts";
import { createTempRepo, removeTempRepo, scrubGitEnv, writeConfig } from "./test-support.ts";

let temp: TempRepo;

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo("agent-hooks-profile-");
});

afterEach(() => {
  removeTempRepo(temp);
});

const APPROVALS = `"approvals": {
  "workflows": { "release.yml": ["on publie", "release"] },
  "labels": { "ok-humain": ["ok #{pr}", "ok pour la #{pr}"] }
}`;

function profileOf(jsonc: string): ProfileKeys {
  writeConfig(temp.repo, jsonc);

  return loadProfile(configPath(temp.repo));
}

describe("loadProfile", () => {
  test("without the file, every key is absent", () => {
    expect(loadProfile(configPath(temp.repo))).toEqual({
      landing: { kind: "absent" },
      approvals: { kind: "absent" },
      commitMessages: { kind: "absent" },
    });
  });

  test("a file that does not parse, or whose profile is no object, leaves every key unreadable, naming the error", () => {
    const invalid = profileOf("{ nope");

    for (const read of [invalid.landing, invalid.approvals, invalid.commitMessages]) {
      expect(read.kind).toBe("unreadable");
      expect(read.kind === "unreadable" ? read.error : "").toStartWith(
        `agent-hooks: ${configPath(temp.repo)}: invalid JSONC: `,
      );
    }

    const unreadable = {
      kind: "unreadable",
      error: `agent-hooks: ${configPath(temp.repo)}: profile: expected an object`,
    } as const;

    expect(profileOf(`{ "profile": 1 }`)).toEqual({
      landing: unreadable,
      approvals: unreadable,
      commitMessages: unreadable,
    });
  });

  test("a file that cannot be read leaves every key unreadable, naming the error", () => {
    mkdirSync(configPath(temp.repo), { recursive: true });
    const read = loadProfile(configPath(temp.repo));

    for (const key of [read.landing, read.approvals, read.commitMessages]) {
      expect(key.kind === "unreadable" ? key.error : "").toStartWith(
        `agent-hooks: ${configPath(temp.repo)}: cannot read: `,
      );
    }
  });

  test("reads the file once for every key", () => {
    writeConfig(
      temp.repo,
      `{ "profile": { "landing": { "trunk": "dev", "release": "main" }, "commitMessages": "judged", ${APPROVALS} } }`,
    );
    const reads = spyOn(fs, "readFileSync");

    try {
      loadProfile(configPath(temp.repo));

      expect(reads.mock.calls.filter(([file]) => file === configPath(temp.repo))).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }
  });

  test("reads profile.landing alone: the rest of the file, the other profile keys included, may be invalid", () => {
    expect(
      profileOf(
        `{ "presets": ["no-such-preset"], "profile": { "landing": { "trunk": "dev", "release": "main" }, "worktree": "each", "review": {}, "later": 1 } }`,
      ).landing,
    ).toEqual({ kind: "read", value: { trunk: "dev", release: "main", by: "agent" } });
  });

  test("no landing reads as absent", () => {
    expect(profileOf(`{ "profile": { "worktree": "per-task" } }`).landing).toEqual({
      kind: "absent",
    });
    expect(profileOf("{}").landing).toEqual({ kind: "absent" });
  });

  test("reports an invalid landing, naming its key", () => {
    expect(profileOf(`{ "profile": { "landing": { "trunk": "dev" } } }`).landing).toEqual({
      kind: "unreadable",
      error: `agent-hooks: ${configPath(temp.repo)}: profile.landing.release: expected a branch name`,
    });
  });

  test("reads profile.approvals alone, absent without it", () => {
    const read = profileOf(
      `{ "presets": ["no-such-preset"], "profile": { "worktree": "each", ${APPROVALS} } }`,
    ).approvals;

    expect(read.kind === "read" ? read.value.labels.map((label) => label.name) : []).toEqual([
      "ok-humain",
    ]);
    expect(
      profileOf(`{ "profile": { "landing": { "trunk": "dev", "release": "main" } } }`).approvals,
    ).toEqual({ kind: "absent" });
  });

  test("reads profile.commitMessages alone: the rest of the file may be invalid", () => {
    expect(
      profileOf(
        `{ "presets": ["no-such-preset"], "profile": { "commitMessages": "judged", "worktree": "each" } }`,
      ).commitMessages,
    ).toEqual({ kind: "read", value: "judged" });
  });

  test("no commitMessages reads as absent, an invalid one names its key", () => {
    expect(profileOf("{}").commitMessages).toEqual({ kind: "absent" });
    expect(profileOf(`{ "profile": { "commitMessages": true } }`).commitMessages).toEqual({
      kind: "unreadable",
      error: `agent-hooks: ${configPath(temp.repo)}: profile.commitMessages: expected judged`,
    });
  });

  test("an invalid key leaves the others read: an invalid approvals keeps the landing, and an invalid landing the approvals", () => {
    const approvalsInvalid = profileOf(
      `{ "profile": { "landing": { "trunk": "dev", "release": "main" }, "approvals": {}, "commitMessages": "judged" } }`,
    );

    expect(approvalsInvalid).toEqual({
      landing: { kind: "read", value: { trunk: "dev", release: "main", by: "agent" } },
      approvals: {
        kind: "unreadable",
        error: `agent-hooks: ${configPath(temp.repo)}: profile.approvals: expected workflows or labels`,
      },
      commitMessages: { kind: "read", value: "judged" },
    });

    const landingInvalid = profileOf(
      `{ "profile": { "landing": { "trunk": "main", "release": "main" }, ${APPROVALS} } }`,
    );

    expect(landingInvalid.landing).toEqual({
      kind: "unreadable",
      error: `agent-hooks: ${configPath(temp.repo)}: profile.landing: trunk and release name one branch`,
    });
    expect(landingInvalid.approvals.kind).toBe("read");
    expect(landingInvalid.commitMessages).toEqual({ kind: "absent" });
  });
});

describe("parseProfile", () => {
  test("reads the profile of a text as a commit holds the file, the rest of the file unread", () => {
    expect(
      parseProfile(
        "dev:agent-hooks.jsonc",
        `{ "stop": 1, "profile": { "review": { "risky": ["a"] }, "worktree": "per-task" } }`,
      ),
    ).toEqual({
      landing: null,
      approvals: null,
      review: { risky: ["a"] },
      worktree: "per-task",
      commitMessages: null,
    });
  });

  test("names the file and the key in an error, an unknown profile key included", () => {
    expect(() => parseProfile("dev:agent-hooks.jsonc", "{")).toThrow(
      "agent-hooks: dev:agent-hooks.jsonc: invalid JSONC: ",
    );
    expect(() => parseProfile("dev:agent-hooks.jsonc", `{ "profile": { "review": {} } }`)).toThrow(
      "agent-hooks: dev:agent-hooks.jsonc: profile.review.risky: expected a list of globs",
    );
    expect(() =>
      parseProfile("dev:agent-hooks.jsonc", `{ "profile": { "reveiw": { "risky": ["a"] } } }`),
    ).toThrow("agent-hooks: dev:agent-hooks.jsonc: profile.reveiw: unknown key");
    expect(() =>
      parseProfile("dev:agent-hooks.jsonc", `{ "profile": { "worktree": "each" } }`),
    ).toThrow("agent-hooks: dev:agent-hooks.jsonc: profile.worktree: expected per-task|shared");
  });
});
