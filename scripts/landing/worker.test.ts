import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeAtomicSync } from "../../tools/platform/fs.ts";
import { takeRunLock } from "../headless/headless-run.ts";
import {
  GRACE_MS,
  type LandRun,
  MAX_WAIT_MS,
  type OpenPullRequest,
  RETRY_MS,
  runWorkerOnce,
  SIGNING_COMMENT,
  targetsOf,
  verdictOf,
  type WorkerDeps,
} from "./worker.ts";

const START = Date.parse("2026-11-03T10:00:00Z");

/** A label date old enough that no target waits for the landing that put it on. */
const LONG_AGO = "2026-11-03T08:00:00Z";

const HUMAN_REFUSAL =
  "land: #12 is tier:human (a hook matches more), with no land-ok label: it lands once the human types /land 12 in a session; stop";

function pr(
  number: number,
  labels: readonly string[],
  {
    base = "dev",
    branch = `feature/f-${number}`,
    head = `${number}`.padEnd(40, "a"),
    draft = false,
  } = {},
): OpenPullRequest {
  return { number, head, branch, base, labels, draft };
}

interface World {
  open: OpenPullRequest[];
  /** What a run of `land.ts <n>` does to GitHub, beside printing its output. */
  effects: Map<number, () => void>;
  /** The `labeled` events of each pull request, oldest first. */
  labelled: Map<number, (readonly [string, string])[]>;
  comments: { readonly number: string; readonly body: string }[];
  landed: number[];
  runs: Map<number, LandRun>;
  now: number;
  behind: Set<string>;
  signs: boolean;
  held: boolean;
  failing: Set<number>;
  ghCalls: number;
}

let dir = "";

let world: World;

/** A pull request as `gh --json number,headRefOid,headRefName,baseRefName,labels,isDraft` prints it. */
function shown(open: OpenPullRequest) {
  return {
    number: open.number,
    headRefOid: open.head,
    headRefName: open.branch,
    baseRefName: open.base,
    labels: open.labels.map((name) => ({ name })),
    isDraft: open.draft,
  };
}

function refusal(stderr: string): LandRun {
  return { exitCode: 1, stdout: "", stderr };
}

function deps(): WorkerDeps {
  return {
    gh: (args) => {
      world.ghCalls += 1;

      const [command, verb, subject] = args;

      if (command === "pr" && verb === "list") {
        return Promise.resolve(JSON.stringify(world.open.map((open) => shown(open))));
      }

      if (command === "pr" && verb === "view") {
        const viewed = world.open.find((open) => String(open.number) === subject);

        return viewed === undefined
          ? Promise.reject(new Error(`no pull request ${subject}`))
          : Promise.resolve(JSON.stringify(shown(viewed)));
      }

      if (command === "api") {
        const number = Number(/issues\/(\d+)\/events/u.exec(verb ?? "")?.[1]);

        if (world.failing.has(number))
          return Promise.reject(new Error(`gh api: HTTP 502 for #${number}`));

        const events = world.labelled.get(number) ?? [
          ["land-ok", LONG_AGO],
          ["tier:low", LONG_AGO],
        ];

        return Promise.resolve(events.map(([label, at]) => `${label} ${at}\n`).join(""));
      }

      if (command === "pr" && verb === "comment") {
        world.comments.push({ number: subject ?? "", body: args[4] ?? "" });

        return Promise.resolve("");
      }

      return Promise.reject(new Error(`no answer for gh ${args.join(" ")}`));
    },
    land: (target) => {
      world.landed.push(target);
      world.effects.get(target)?.();

      return (
        world.runs.get(target) ?? {
          exitCode: 0,
          stdout: `landed #${target} on dev at 1234abcd\n`,
          stderr: "",
        }
      );
    },
    probeSigning: () => {
      if (!world.signs)
        throw new Error("commits cannot be signed (gpg: signing failed: No pinentry)");
    },
    holdsDev: (head) => !world.behind.has(head),
    landingHeld: () => world.held,
    now: () => world.now,
    dir,
    repository: "github.com/o/r",
  };
}

function pass(): Promise<readonly string[]> {
  return runWorkerOnce(deps());
}

function workerLog(): string {
  return readFileSync(join(dir, "worker.log"), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "landing-worker-"));
  world = {
    open: [],
    effects: new Map(),
    labelled: new Map(),
    comments: [],
    landed: [],
    runs: new Map(),
    now: START,
    behind: new Set(),
    signs: true,
    held: false,
    failing: new Set(),
    ghCalls: 0,
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("targetsOf", () => {
  test("keeps the top of each chain whose layers are each landable, and each landable pull request on dev", () => {
    const open = [
      pr(9, ["land-ok"], { branch: "feature/a" }),
      pr(10, ["tier:low"], { base: "feature/a", branch: "feature/b" }),
      pr(12, ["land-ok", "tier:human"]),
      pr(14, ["tier:low"]),
      pr(15, ["tier:low"], { draft: true }),
      pr(16, ["tier:low", "needs-human"]),
      pr(17, ["land-ok"], { branch: "renovate/x" }),
      pr(18, []),
    ];

    expect(targetsOf(open).map(({ number }) => number)).toEqual([10, 12, 14]);
  });

  test("lands no stack in part: one with an unapproved layer anywhere, or that forks, waits for a session", () => {
    const bottom = pr(9, ["land-ok"], { branch: "feature/a" });
    const unapproved = pr(10, ["tier:human"], { base: "feature/a", branch: "feature/b" });

    expect(
      targetsOf([
        bottom,
        unapproved,
        pr(11, ["land-ok"], { base: "feature/b", branch: "feature/c" }),
      ]),
    ).toEqual([]);
    expect(targetsOf([bottom, unapproved])).toEqual([]);
    expect(
      targetsOf([
        bottom,
        unapproved,
        pr(11, ["tier:low"], { base: "feature/b", branch: "feature/c" }),
      ]),
    ).toEqual([]);
    expect(
      targetsOf([
        bottom,
        pr(10, ["land-ok"], { base: "feature/a", branch: "feature/b" }),
        pr(11, ["land-ok"], { base: "feature/a", branch: "feature/c" }),
      ]),
    ).toEqual([]);
    expect(targetsOf([pr(9, ["tier:low"], { branch: "feature/a" }), unapproved])).toEqual([]);
  });

  test("lands nothing above a base that no open pull request, or two, head", () => {
    expect(targetsOf([pr(10, ["land-ok"], { base: "feature/gone" })])).toEqual([]);
    expect(
      targetsOf([
        pr(9, ["land-ok"], { branch: "feature/a" }),
        pr(8, ["land-ok"], { branch: "feature/a" }),
        pr(10, ["land-ok"], { base: "feature/a" }),
      ]).map(({ number }) => number),
    ).toEqual([]);
  });
});

describe("verdictOf", () => {
  test("is the landed line, else the last land: line, else the last line", () => {
    expect(
      verdictOf({
        exitCode: 0,
        stdout: "landed #7 on dev at 1234abcd; remote branch deleted\n",
        stderr: "land: the checkout .claude/worktrees/land-feature-x it added stays\n",
      }),
    ).toBe("landed #7 on dev at 1234abcd; remote branch deleted");
    expect(
      verdictOf(
        refusal(
          "land: pushed feature/x at 1234abcd, but the push to dev was refused; fix what it names, then land again:\nerror: failed to push some refs\n",
        ),
      ),
    ).toBe(
      "land: pushed feature/x at 1234abcd, but the push to dev was refused; fix what it names, then land again:",
    );
    expect(verdictOf(refusal("Usage: bun ./scripts/land.ts …\n"))).toBe(
      "Usage: bun ./scripts/land.ts …",
    );
    expect(verdictOf({ exitCode: 1, stdout: "", stderr: "" })).toBe("land.ts printed nothing");
  });
});

describe("runWorkerOnce", () => {
  test("lands each target once, by number, and logs each run", async () => {
    world.open = [
      pr(14, ["tier:low"]),
      pr(12, ["land-ok", "tier:human"]),
      pr(10, ["land-ok"], { base: "feature/a", branch: "feature/b" }),
      pr(9, ["land-ok"], { branch: "feature/a" }),
    ];
    world.runs.set(12, refusal(`${HUMAN_REFUSAL}\n`));

    expect(await pass()).toEqual([
      "landing-worker: #10: landed #10 on dev at 1234abcd",
      `landing-worker: #12: ${HUMAN_REFUSAL}`,
      "landing-worker: #14: landed #14 on dev at 1234abcd",
    ]);
    expect(world.landed).toEqual([10, 12, 14]);
    expect(workerLog()).toContain(
      `--- 2026-11-03T10:00:00.000Z github.com/o/r#12 12aaaaaa\n${HUMAN_REFUSAL}\n`,
    );
  });

  test("waits an hour after a new refusal, twice as long after each repeat of it, four hours at most", async () => {
    world.open = [pr(12, ["land-ok", "tier:human"])];
    world.runs.set(12, refusal(`${HUMAN_REFUSAL}\n`));

    await pass();
    world.now = START + 5 * 60 * 1000;

    expect(await pass()).toEqual([
      `landing-worker: #12 skipped, unchanged since: ${HUMAN_REFUSAL}`,
    ]);

    // Each run waits twice as long as the one before: 1 h, then 2 h, then 4 h, the most it waits.
    let at = START;

    for (const wait of [RETRY_MS, 2 * RETRY_MS, MAX_WAIT_MS, MAX_WAIT_MS]) {
      world.now = at + wait - 1;
      await pass();
      world.now = at + wait;
      await pass();
      at = world.now;
    }

    expect(world.landed).toHaveLength(5);
  });

  test("counts as a repeat a refusal that names another run", async () => {
    let run = 0;

    world.open = [pr(12, ["tier:low"])];
    world.effects.set(12, () => {
      run += 1;
      world.runs.set(
        12,
        refusal(`land: #12's e2e run https://github.com/o/r/actions/runs/${run} failed\n`),
      );
    });

    await pass();
    world.now = START + RETRY_MS;
    await pass();
    world.now = START + 2 * RETRY_MS;
    await pass();

    expect(world.landed).toEqual([12, 12]);
  });

  test("remembers the pull request as its run left it: the tier label a landing puts on is no change", async () => {
    world.open = [pr(12, ["land-ok"])];
    world.runs.set(12, refusal(`${HUMAN_REFUSAL}\n`));
    world.effects.set(12, () => {
      world.open = [pr(12, ["land-ok", "tier:low"])];
    });

    await pass();
    world.now = START + 5 * 60 * 1000;

    expect(await pass()).toEqual([
      `landing-worker: #12 skipped, unchanged since: ${HUMAN_REFUSAL}`,
    ]);
    expect(world.landed).toEqual([12]);
  });

  test("runs again at once a target whose head, tier labels or land-ok changed", async () => {
    world.open = [pr(12, ["land-ok"])];
    world.runs.set(12, refusal(`${HUMAN_REFUSAL}\n`));

    await pass();
    world.open = [pr(12, ["land-ok"], { head: "c".repeat(40) })];
    await pass();
    world.labelled.set(12, [["land-ok", "2026-11-03T09:00:00Z"]]);
    await pass();
    world.open = [pr(12, ["land-ok", "tier:human"], { head: "c".repeat(40) })];
    await pass();

    expect(world.landed).toEqual([12, 12, 12, 12]);
  });

  test("leaves a pull request labelled within the quarter hour to the landing that labelled it", async () => {
    world.open = [pr(12, ["land-ok"])];
    world.labelled.set(12, [["land-ok", "2026-11-03T09:55:00Z"]]);

    expect(await pass()).toEqual([
      "landing-worker: #12 waits: labelled 5 min ago, for the landing that labelled it",
    ]);

    world.now = Date.parse("2026-11-03T09:55:00Z") + GRACE_MS;
    await pass();

    expect(world.landed).toEqual([12]);
  });

  test("ends the pass while a landing holds dev", async () => {
    world.open = [pr(12, ["tier:low"]), pr(14, ["tier:low"])];
    world.held = true;

    expect(await pass()).toEqual([
      "landing-worker: a landing holds dev: #12 and the rest wait for the next pass",
    ]);
    expect(world.landed).toEqual([]);
  });

  test("comments once and lands nothing when a rebase needs a signature this machine cannot make", async () => {
    const behind = pr(12, ["tier:low"]);

    world.open = [behind];
    world.behind.add(behind.head);
    world.signs = false;

    const [line] = await pass();

    expect(line).toBe(
      "landing-worker: #12: land: a rebase needs a signature this machine cannot make: commits cannot be signed (gpg: signing failed: No pinentry)",
    );
    expect(world.comments).toEqual([{ number: "12", body: SIGNING_COMMENT }]);
    expect(world.landed).toEqual([]);

    world.now = START + RETRY_MS;
    await pass();

    expect(world.comments).toHaveLength(1);

    const pushed = pr(12, ["tier:low"], { head: "c".repeat(40) });

    world.open = [pushed];
    world.behind.add(pushed.head);
    await pass();

    expect(world.comments).toHaveLength(2);
    expect(world.landed).toEqual([]);
  });

  test("lands with no signing probe what needs no rebase: a head holding dev, or a stack", async () => {
    world.open = [
      pr(9, ["land-ok"], { branch: "feature/a" }),
      pr(10, ["land-ok"], { base: "feature/a", branch: "feature/b" }),
      pr(12, ["tier:low"]),
    ];
    world.behind.add(world.open[1]?.head ?? "");
    world.signs = false;

    await pass();

    expect(world.landed).toEqual([10, 12]);
    expect(world.comments).toEqual([]);
  });

  test("goes on to the next target when GitHub fails on one", async () => {
    world.open = [pr(12, ["tier:low"]), pr(14, ["tier:low"])];
    world.failing.add(12);

    expect(await pass()).toEqual([
      "landing-worker: #12: gh api: HTTP 502 for #12",
      "landing-worker: #14: landed #14 on dev at 1234abcd",
    ]);
  });

  test("drops from its memo this repository's pull requests no longer open, and keeps another's", async () => {
    const other = { key: "x", verdict: "land: elsewhere", at: START, wait: RETRY_MS };

    writeAtomicSync(join(dir, "worker.json"), JSON.stringify({ "github.com/o/other#12": other }));
    world.open = [pr(12, ["tier:low"]), pr(14, ["tier:low"])];
    world.runs.set(12, refusal(`${HUMAN_REFUSAL}\n`));
    world.runs.set(14, refusal(`${HUMAN_REFUSAL}\n`));

    await pass();
    world.open = [pr(14, ["tier:low"])];
    world.now = START + 60 * 1000;
    await pass();

    expect(Object.keys(JSON.parse(readFileSync(join(dir, "worker.json"), "utf8")))).toEqual([
      "github.com/o/other#12",
      "github.com/o/r#14",
    ]);
  });

  test("ends at once while another worker runs, asking GitHub nothing", async () => {
    world.open = [pr(12, ["tier:low"])];

    const held = takeRunLock(
      { lock: join(dir, "worker.lock"), holder: join(dir, "worker-holder.json") },
      { pid: 1, since: "2026-11-03T09:59:00Z" },
    );

    try {
      expect(await pass()).toEqual(["landing-worker: another worker runs: this pass ends"]);
    } finally {
      if (held !== null) closeSync(held);
    }

    expect(world.ghCalls).toBe(0);
    expect(world.landed).toEqual([]);
  });

  test("refuses a memo that does not read, naming its file", async () => {
    world.open = [pr(12, ["tier:low"])];
    writeAtomicSync(join(dir, "worker.json"), '{"github.com/o/r#12": {"key": 3}}');

    await expect(pass()).rejects.toThrow(
      `${join(dir, "worker.json")} holds an entry that does not read`,
    );
  });
});
