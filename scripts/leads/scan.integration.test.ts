import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  contextIn,
  FakeGitHub,
  type FakeIssue,
  type History,
  landHistory,
  npmWith,
  REPO,
  type Sandbox,
  sandbox,
} from "./harness.fixture.ts";
import { PR_409_BODY } from "./leads.fixture.ts";
import { type GitHub, type Json, leadMarker, scanMarker } from "./lib.ts";
import { claim, publish, release, search } from "./scan.ts";

const NOW = Date.parse("2026-10-30T06:00:00Z");

const RIVAL = "11111111-1111-4111-8111-111111111111";

const SESSION_ENV = { CLAUDE_CODE_REMOTE_SESSION_ID: "session_01ABC" };

let box: Sandbox;

let shas: History;

let gh: FakeGitHub;

let scan: FakeIssue;

beforeEach(() => {
  box = sandbox();
  shas = landHistory(box);
  gh = new FakeGitHub();
  gh.pulls.set(shas.zustand, [
    {
      number: 409,
      user: { login: "renovate[bot]" },
      head: { ref: "renovate/zustand-5.x" },
      body: PR_409_BODY,
    },
  ]);
  scan = gh.addIssue({
    title: "scan(zustand@5.0.16): perf fix in useStore",
    body: `facts\n\n${scanMarker(shas.zustand, "zustand")}`,
    labels: ["lead:scan-minor", "needs-human"],
  });
});

afterEach(() => {
  box.cleanup();
});

function world() {
  return contextIn(box, gh, { env: SESSION_ENV, npm: npmWith("") });
}

function claimed(): Promise<number> {
  return claim(world().ctx, "minor", scan.number, NOW);
}

function leadsFile(leads: Json): string {
  const file = `.leads/${scan.number}-leads.json`;

  mkdirSync(join(box.root, ".leads"), { recursive: true });
  writeFileSync(join(box.root, file), JSON.stringify({ leads }));

  return file;
}

function lead(fields: Readonly<Record<string, Json>> = {}): Json {
  return {
    package: "zustand",
    api: "useStore",
    category: "cleanup",
    key: "drop the server snapshot memo",
    summary: "useStore no longer memoizes getServerSnapshot; the comment's pending fix has landed",
    evidence: [`.leads/${scan.number}/vellum/src/state.ts:2`],
    done_when: ["vellum/src/state.ts holds no TODO about getServerSnapshot"],
    hints: "Probably a one-line removal.",
    ...fields,
  };
}

function leadIssues(): FakeIssue[] {
  return gh.issues.filter((issue) => issue.labels.includes("lead"));
}

describe("claim", () => {
  test("labels the issue, says who holds it, and lays out origin/dev and the update's files", async () => {
    const { ctx, printed } = world();

    expect(await claim(ctx, "minor", scan.number, NOW)).toBe(0);
    expect(scan.labels).toContain("lead:in-progress");
    expect(scan.comments.map((comment) => comment.body)).toEqual([
      expect.stringMatching(/^claimed by session_01ABC \(claim [0-9a-f-]{36}\)$/u),
    ]);

    const tree = join(box.root, ".leads", String(scan.number));

    expect(box.git("-C", tree, "rev-parse", "HEAD")).toBe(box.git("rev-parse", "origin/dev"));
    expect(readFileSync(`${tree}-notes.md`, "utf8")).toContain("getServerSnapshot");
    expect(existsSync(`${tree}-types.diff`)).toBe(true);

    expect(printed[0]).toStartWith('<scan-facts>{"sha":"');
    expect(printed).toContain(`tree: .leads/${scan.number}`);
    expect(printed).toContain("existing leads: none");
    expect(printed.at(-1)).toBe(`write leads to: .leads/${scan.number}-leads.json`);
  });

  test("removes the query, leads and release files an earlier run left for the issue", async () => {
    const stale = ["query.txt", "leads.json", "release.json"].map((kind) =>
      join(box.root, ".leads", `${scan.number}-${kind}`),
    );

    mkdirSync(join(box.root, ".leads"), { recursive: true });

    for (const file of stale) writeFileSync(file, "{}");

    expect(await claimed()).toBe(0);
    expect(stale.filter((file) => existsSync(file))).toEqual([]);
  });

  test("without --issue it takes the oldest free scan of its tier", async () => {
    const { ctx, printed } = world();

    expect(await claim(ctx, "minor", null, NOW)).toBe(0);
    expect(printed).toContain(`issue: #${scan.number}`);
  });

  test("lists the leads already filed for the package, closed ones included", async () => {
    gh.addIssue({
      title: "lead(zustand): refused earlier",
      body: leadMarker("zustand", "drop the server snapshot memo"),
      labels: ["lead"],
      state: "closed",
    });

    const { ctx, printed } = world();

    await claim(ctx, "minor", scan.number, NOW);
    expect(printed).toContain(
      "- drop-the-server-snapshot-memo — lead(zustand): refused earlier (closed)",
    );
  });

  test.each([
    ["another tier's label", (issue: FakeIssue) => (issue.labels = ["lead:scan-major"])],
    ["no marker", (issue: FakeIssue) => (issue.body = "facts")],
    ["an author who cannot push", (issue: FakeIssue) => (issue.author_association = "NONE")],
    ["a closed issue", (issue: FakeIssue) => (issue.state = "closed")],
    ["an issue given up on", (issue: FakeIssue) => issue.labels.push("lead:unsure")],
  ])("refuses %s: nothing to scan, nothing written", async (_, change) => {
    change(scan);

    const { ctx, printed } = world();

    expect(await claim(ctx, "minor", scan.number, NOW)).toBe(0);
    expect(printed[0]).toStartWith("nothing to scan: ");
    expect(gh.writes).toEqual([]);
  });

  test("of two scans fired at once, the one whose claim comment comes second stands down", async () => {
    const racing: GitHub = {
      call(method, path, body) {
        const answer = gh.call(method, path, body);

        // The rival comments between this scan's label and its own comment.
        if (method === "POST" && path.endsWith(`/issues/${scan.number}/labels`)) {
          gh.comment(scan, `claimed by session_rival (claim ${RIVAL})`);
        }

        return answer;
      },
      list: (path) => gh.list(path),
    };

    const { ctx, printed } = contextIn(box, racing, { env: SESSION_ENV, npm: npmWith("") });

    expect(await claim(ctx, "minor", scan.number, NOW)).toBe(0);
    expect(printed.at(-1)).toBe(`nothing to scan: another scan claimed #${scan.number} first`);
    expect(existsSync(join(box.root, ".leads", String(scan.number)))).toBe(false);
  });

  test("refuses an issue a scan claimed an hour ago, takes one claimed seven hours ago", async () => {
    gh.now = "2026-10-30T05:00:00Z";
    gh.call("POST", `repos/${REPO}/issues/${scan.number}/labels`, { labels: ["lead:in-progress"] });
    gh.takeWrites();

    const early = world();

    expect(await claim(early.ctx, "minor", scan.number, NOW)).toBe(0);
    expect(early.printed).toEqual([`nothing to scan: a scan holds #${scan.number} already`]);

    gh.now = "2026-10-30T12:00:00Z";

    const late = world();

    expect(await claim(late.ctx, "minor", scan.number, Date.parse("2026-10-30T12:00:00Z"))).toBe(0);
    expect(
      gh
        .takeWrites()
        .filter((write) => write.includes("/labels"))
        .slice(0, 2),
    ).toEqual([
      `DELETE issues/${scan.number}/labels/lead%3Ain-progress`,
      `POST issues/${scan.number}/labels`,
    ]);
    expect(scan.events.at(-1)).toEqual({
      event: "labeled",
      label: "lead:in-progress",
      created_at: "2026-10-30T12:00:00Z",
    });
  });
});

describe("publish", () => {
  test("files each lead, links them on the scan issue, closes it and removes its tree", async () => {
    await claimed();

    const { ctx, printed } = world();

    expect(publish(ctx, scan.number, leadsFile([lead()]))).toBe(0);

    const [filed] = leadIssues();
    const tree = box.git("rev-parse", "origin/dev");

    expect(filed?.labels).toEqual(["lead", "needs-human"]);
    expect(filed?.title).toBe(
      "lead(zustand): useStore no longer memoizes getServerSnapshot; the comment's pending …",
    );
    expect(filed?.body).toContain(
      `- [vellum/src/state.ts:2](https://github.com/${REPO}/blob/${tree}/vellum/src/state.ts#L2)`,
    );
    expect(filed?.body).toContain("- [ ] `bun ./scripts/run-gates.ts` passes");
    expect(filed?.body).not.toContain("don't memoize");
    expect(filed?.body).toEndWith(leadMarker("zustand", "drop the server snapshot memo"));

    expect(scan.state).toBe("closed");
    expect(scan.labels).toEqual(["lead:scan-minor", "needs-human"]);
    expect(scan.comments.at(-1)?.body).toBe(
      `Leads of this update:\n\n- #${filed?.number} ${filed?.title}`,
    );
    expect(existsSync(join(box.root, ".leads", String(scan.number)))).toBe(false);
    expect(printed.at(-1)).toBe(`closed #${scan.number}`);
  });

  test("zero leads close the scan with no lead", async () => {
    await claimed();

    expect(publish(world().ctx, scan.number, leadsFile([]))).toBe(0);
    expect(leadIssues()).toEqual([]);
    expect(scan.comments.at(-1)?.body).toBe("no lead");
    expect(scan.state).toBe("closed");
  });

  test("a lead refused before, under the same key in other case, is not filed again", async () => {
    const refused = gh.addIssue({
      title: "lead(zustand): refused",
      body: leadMarker("zustand", "Drop the server snapshot memo"),
      labels: ["lead"],
      state: "closed",
    });

    await claimed();

    expect(
      publish(
        world().ctx,
        scan.number,
        leadsFile([lead({ key: "DROP the server-snapshot memo" })]),
      ),
    ).toBe(0);
    expect(leadIssues()).toEqual([refused]);
    expect(scan.comments.at(-1)?.body).toContain(`- duplicate of #${refused.number}: `);
  });

  test("an invalid file writes nothing, and the scan keeps its issue", async () => {
    await claimed();
    gh.takeWrites();

    const { ctx, printed } = world();
    const file = leadsFile([lead({ evidence: [`.leads/${scan.number}/vellum/src/missing.ts:1`] })]);

    expect(publish(ctx, scan.number, file)).toBe(1);
    expect(printed[0]).toContain("is not in the scanned tree");
    expect(gh.takeWrites()).toEqual([]);
    expect(scan.state).toBe("open");
    expect(existsSync(join(box.root, ".leads", String(scan.number)))).toBe(true);
  });

  test("publish before claim fails, naming claim", () => {
    expect(() => publish(world().ctx, scan.number, leadsFile([]))).toThrow("run claim first");
  });

  test("a scan whose claim another took over publishes nothing", async () => {
    await claimed();

    // Six hours on, the gate fired the issue again and another scan took it.
    gh.now = "2026-10-30T13:00:00Z";
    gh.call("DELETE", `repos/${REPO}/issues/${scan.number}/labels/lead%3Ain-progress`);
    gh.call("POST", `repos/${REPO}/issues/${scan.number}/labels`, { labels: ["lead:in-progress"] });
    gh.comment(scan, `claimed by session_rival (claim ${RIVAL})`);
    gh.takeWrites();

    const { ctx, printed } = world();

    expect(publish(ctx, scan.number, leadsFile([lead()]))).toBe(1);
    expect(printed.at(-1)).toBe(`leads: another scan holds #${scan.number} now; nothing published`);
    expect(gh.takeWrites()).toEqual([]);
  });

  test("a file other than the issue's own is refused before anything is read", async () => {
    await claimed();

    expect(() => publish(world().ctx, scan.number, ".leads/999-leads.json")).toThrow(
      `#${scan.number}'s leads file is .leads/${scan.number}-leads.json`,
    );
  });
});

function query(text: string): string {
  const file = `.leads/${scan.number}-query.txt`;

  writeFileSync(join(box.root, file), text);

  return file;
}

describe("search", () => {
  test("finds the lines that hold a string, their paths ready for Read", async () => {
    await claimed();

    const { ctx, printed } = world();

    expect(search(ctx, scan.number, query("useStore\n"))).toBe(0);
    expect(printed).toEqual([
      `.leads/${scan.number}/vellum/src/state.ts:3:export const useStore = create(() => ({}));`,
      "1 found",
    ]);
  });

  test("with in: paths alone, lists the files there", async () => {
    await claimed();

    const { ctx, printed } = world();

    expect(search(ctx, scan.number, query("in: vellum\n"))).toBe(0);
    expect(printed).toEqual([
      `.leads/${scan.number}/vellum/package.json`,
      `.leads/${scan.number}/vellum/src/state.ts`,
      "2 found",
    ]);
  });

  test("an in: path is a path, never pathspec magic", async () => {
    await claimed();

    const { ctx, printed } = world();

    expect(search(ctx, scan.number, query("zustand\nin: :(exclude)vellum\n"))).toBe(0);
    expect(printed).toEqual(["0 found"]);
  });
});

describe("release", () => {
  test("gives the issue to the human: lead:unsure, the reason, no tree", async () => {
    await claimed();

    const file = `.leads/${scan.number}-release.json`;

    writeFileSync(
      join(box.root, file),
      JSON.stringify({ reason: "evidence kept failing, see @someone" }),
    );

    expect(release(world().ctx, scan.number, file)).toBe(0);
    expect(scan.labels).toEqual(["lead:scan-minor", "needs-human", "lead:unsure"]);
    expect(scan.state).toBe("open");
    expect(scan.comments.at(-1)?.body).toBe(
      `scan released: evidence kept failing, see @${String.fromCodePoint(0x20_0b)}someone`,
    );
    expect(existsSync(join(box.root, ".leads", String(scan.number)))).toBe(false);
  });

  test("a file without a reason is refused", async () => {
    await claimed();

    const file = `.leads/${scan.number}-release.json`;

    writeFileSync(join(box.root, file), "{}");
    expect(release(world().ctx, scan.number, file)).toBe(1);
    expect(scan.labels).toContain("lead:in-progress");
  });

  test("an issue this scan never claimed gets no label and no comment", () => {
    const bug = gh.addIssue({ title: "a bug", body: "text", labels: ["bug"] });
    const file = `.leads/${bug.number}-release.json`;

    mkdirSync(join(box.root, ".leads"), { recursive: true });
    writeFileSync(join(box.root, file), JSON.stringify({ reason: "ping -@octocat" }));

    expect(() => release(world().ctx, bug.number, file)).toThrow("run claim first");
    expect(bug.labels).toEqual(["bug"]);
    expect(bug.comments).toEqual([]);
  });

  test("a scan issue the human closed meanwhile is not released", async () => {
    await claimed();
    scan.state = "closed";

    const file = `.leads/${scan.number}-release.json`;

    writeFileSync(join(box.root, file), JSON.stringify({ reason: "evidence kept failing" }));

    const { ctx, printed } = world();

    expect(release(ctx, scan.number, file)).toBe(1);
    expect(printed.at(-1)).toBe(`leads: #${scan.number} is no longer open; nothing released`);
    expect(scan.labels).not.toContain("lead:unsure");
  });
});
