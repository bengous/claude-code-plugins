import { describe, expect, test, tier } from "claude-code/testing";

import {
  approved,
  CHANNEL,
  channelLine,
  CWD,
  DATE,
  DIR,
  DRAFTING,
  FILE,
  FINAL,
  inReview,
  link,
  READY,
  refused,
  SERVER,
  sent,
  stage,
  START_PROMPT,
  storedSession,
  WORKDIR,
  world,
} from "./fixtures/index.ts";
import { type Landed, lockVerdict, shellVerdict } from "./lock.ts";
import { editedPath, parseChannel, parseServerLine } from "./parse.ts";
import { submitResult } from "./relay.ts";

tier("user");

const DENIED = {
  kind: "deny",
  reason: `vellum is planning: files outside ${WORKDIR} change after the plan is approved`,
};

const DENIAL = { decision: "deny", reason: DENIED.reason };

const ENGINE = { decision: "ask", reason: "the session's own flow" } as const;

const INSIDE = `${CWD}/${WORKDIR}`;

function landedOn(file: string | null, at: Partial<Landed> = {}): Landed {
  return { file, project: CWD, platform: "posix", ...at };
}

describe("lockVerdict", () => {
  test("a file that lands under the working directory is allowed outright", () => {
    expect(lockVerdict("x", WORKDIR, landedOn(`${INSIDE}mockup.html`))).toEqual({ kind: "allow" });
  });

  test("a file that lands under the project and outside the working directory is denied", () => {
    expect(lockVerdict("x", WORKDIR, landedOn(`${CWD}/src/cli.ts`))).toEqual(DENIED);
  });

  test("a file that lands outside the project is the session's to decide", () => {
    const scratchpad = "/tmp/claude-1000/project/session/scratchpad/issue.md";
    expect(lockVerdict("x", WORKDIR, landedOn(scratchpad))).toEqual({ kind: "check" });
  });

  test("a directory whose name only starts as the project's is outside it", () => {
    expect(lockVerdict("x", WORKDIR, landedOn(`${CWD}-old/src/cli.ts`))).toEqual({ kind: "check" });
    expect(lockVerdict("x", WORKDIR, landedOn(`${INSIDE.slice(0, -1)}-old/plan.md`))).toEqual(
      DENIED,
    );
  });

  test("a project at the root of the file system still holds the lock", () => {
    expect(lockVerdict("x", WORKDIR, landedOn("/etc/hosts", { project: "/" }))).toEqual(DENIED);
  });

  test("a file that lands nowhere known is denied, and the reason names it as written", () => {
    expect(lockVerdict("\\\\host\\share\\x.md", WORKDIR, landedOn(null))).toEqual({
      kind: "deny",
      reason:
        "vellum is planning and cannot tell where \\\\host\\share\\x.md lands; name the file by its full path",
    });
  });

  test("another case does not take a file out of the project: NTFS and APFS fold it", () => {
    expect(lockVerdict("x", WORKDIR, landedOn("/PROJECT/src/cli.ts"))).toEqual(DENIED);
  });

  test("another case of the working directory is not the working directory", () => {
    expect(lockVerdict("x", WORKDIR, landedOn(`${INSIDE.toUpperCase()}plan.md`))).toEqual(DENIED);
  });
});

/** The folder's own name, as a command spells it: `wip-<sid8>`. */
const FOLDER = WORKDIR.split("/").at(-2) ?? "";

const MOVED = {
  kind: "deny",
  reason: `vellum is planning: stay at the project root and name files from there; a cd into ${WORKDIR} keeps the folder busy and blocks the approval on Windows`,
};

const BACKGROUND = {
  kind: "deny",
  reason: `vellum is planning: a background command that uses ${WORKDIR} keeps the folder busy and blocks the approval on Windows; run it in the foreground`,
};

const shell = (command: string, background = false) =>
  shellVerdict({ command, background }, WORKDIR);

describe("shellVerdict", () => {
  test("cd, pushd, Set-Location -Path and sl into the folder are refused, in a compound command and in any case", () => {
    expect(shell(`cd ${WORKDIR}`)).toEqual(MOVED);
    expect(shell(`ls && pushd ./${WORKDIR} && sed -i s/a/b/ plan.md`)).toEqual(MOVED);
    expect(shell(`Set-Location -Path ${WORKDIR.toUpperCase()}`)).toEqual(MOVED);
    expect(shell(`(sl ${WORKDIR}); Get-ChildItem`)).toEqual(MOVED);
  });

  test("a quoted target that holds a space is refused", () => {
    expect(shell(`cd "C:\\Users\\Jean Dupont\\project\\plans\\x\\${FOLDER}"`)).toEqual(MOVED);
  });

  test("a command in the foreground that reads a file of the folder without entering it passes", () => {
    expect(shell(`sed -n 1,20p ${WORKDIR}plan.md`)).toEqual({ kind: "check" });
  });

  test("the same command in the background is refused, and so is a tail -f on the folder", () => {
    expect(shell(`sed -n 1,20p ${WORKDIR}plan.md`, true)).toEqual(BACKGROUND);
    expect(shell(`tail -f ${WORKDIR}log`, true)).toEqual(BACKGROUND);
  });

  test("a command that puts itself in the background and names the folder is refused", () => {
    expect(shell(`nohup bun --watch ${WORKDIR}proto.ts &`)).toEqual(BACKGROUND);
    expect(shell(`bun ${WORKDIR}proto.ts & sleep 1`)).toEqual(BACKGROUND);
    expect(shell(`Start-Process bun ${WORKDIR}proto.ts`)).toEqual(BACKGROUND);
  });

  test("a redirection or a && is no background", () => {
    expect(shell(`bun ${WORKDIR}proto.ts 2>&1 && ls &>/dev/null`)).toEqual({ kind: "check" });
  });

  test("an unquoted target with an escaped space is refused", () => {
    expect(shell(`cd /c/work/Jean\\ Dupont/proj/${WORKDIR}`)).toEqual(MOVED);
  });

  test("cd as a word of an argument moves nowhere, and passes", () => {
    expect(shell(`grep -rn cd ${WORKDIR}plan.md`)).toEqual({ kind: "check" });
    expect(shell(`git commit -m "then cd ${WORKDIR}"`)).toEqual({ kind: "check" });
  });

  test("a cd anywhere else passes", () => {
    expect(shell("cd src && ls")).toEqual({ kind: "check" });
    expect(shell(`cd plans && cat ${FOLDER}/plan.md`)).toEqual({ kind: "check" });
  });
});

describe("lockVerdict on what a Windows disk answers", () => {
  const windows = { project: "C:\\work\\proj", platform: "windows" } as const;

  const workdir = `C:\\work\\proj\\${WORKDIR.replaceAll("/", "\\").slice(0, -1)}`;

  function win(file: string): ReturnType<typeof lockVerdict> {
    return lockVerdict("x", WORKDIR, landedOn(file, windows));
  }

  test("a file under the working directory is allowed outright", () => {
    expect(win(`${workdir}\\plan.md`)).toEqual({ kind: "allow" });
  });

  test("a file not written yet, its tail joined with `/`, is the same file", () => {
    expect(win(`${workdir}/mockups/a.html`)).toEqual({ kind: "allow" });
    expect(win("C:\\work\\proj/src/new.ts")).toEqual(DENIED);
  });

  test("a file under the project and outside the working directory is denied, in any case", () => {
    expect(win("C:\\work\\proj\\src\\cli.ts")).toEqual(DENIED);
    expect(win("c:\\WORK\\PROJ\\src\\cli.ts")).toEqual(DENIED);
  });

  test("a file on the project's drive, on another or on a share is the session's to decide", () => {
    for (const file of ["C:\\Temp\\x.md", "C:\\work\\proj2\\x.md", "D:\\work\\proj\\x.md"]) {
      expect(win(file), file).toEqual({ kind: "check" });
    }
  });

  test("a project at the root of a drive holds the whole drive", () => {
    expect(
      lockVerdict("x", WORKDIR, landedOn("C:\\src\\cli.ts", { ...windows, project: "C:\\" })),
    ).toEqual(DENIED);
  });
});

describe("the lock places a path before it decides", () => {
  test("a file not written yet lands under the first of its folders that exists", async ($, on) => {
    world(on);
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `${INSIDE}mockups/v2/a.html` } }),
    ).toEqual({ decision: "allow" });

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `${CWD}/docs/new/page.md` } }),
    ).toEqual(DENIAL);
  });

  test("a link in the working directory that leads into the project is the project", async ($, on) => {
    world(on, { disk: new Map([[`${INSIDE}link`, link("../../../src")]]) });
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    for (const file_path of [`${INSIDE}link/cli.ts`, `${INSIDE}link/new.ts`]) {
      expect(await $.tool.check({ tool: "Edit", input: { file_path } }), file_path).toEqual(DENIAL);
    }
  });

  test("a link that leads out of the project is the session's to decide", async ($, on) => {
    world(on, {
      disk: new Map([
        [`${INSIDE}out`, link("/tmp")],
        ["/tmp", DIR],
      ]),
    });
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `${INSIDE}out/x.md` } }),
    ).toEqual(ENGINE);
  });

  test("a project reached through a link is still the project", async ($, on) => {
    world(on, { disk: new Map([["/alias", link(CWD)]]) });
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: "/alias/src/cli.ts" } }),
    ).toEqual(DENIAL);

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `/alias/${WORKDIR}plan.md` } }),
    ).toEqual({ decision: "allow" });
  });

  test("a link that leads nowhere is denied: the tool would write where it points", async ($, on) => {
    world(on, { disk: new Map([[`${INSIDE}dangling`, link("../../../src/new.ts")]]) });
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `${INSIDE}dangling` } }),
    ).toMatchObject({ decision: "deny", reason: expect.stringContaining("cannot tell where") });
  });

  test("a spelling Windows reads as a drive, and a path no folder of which answers, are denied", async ($, on) => {
    world(on);
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    for (const file_path of ["D:plan.md", `${INSIDE}C:stream`, "//host/share/x.md"]) {
      expect(await $.tool.check({ tool: "Write", input: { file_path } }), file_path).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("cannot tell where"),
      });
    }
  });

  test("on POSIX a backslash is a character of a name, never a separator", async ($, on) => {
    world(on);
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);
    const named = WORKDIR.replaceAll("/", "\\");

    for (const file_path of [
      `${CWD}/${named}x.md`,
      `${named}x.md`,
      `${INSIDE.slice(0, -1)}\\x.md`,
    ]) {
      expect(await $.tool.check({ tool: "Write", input: { file_path } }), file_path).toEqual(
        DENIAL,
      );
    }

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `${CWD}\\${named}x.md` } }),
    ).toEqual(ENGINE);
  });

  test("a working directory that is a link into the project allows nothing there", async ($, on) => {
    world(on, { disk: new Map([[INSIDE.slice(0, -1), link("../../src")]]) });
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    for (const file_path of [`${CWD}/src/cli.ts`, `${INSIDE}plan.md`]) {
      expect(await $.tool.check({ tool: "Write", input: { file_path } }), file_path).toEqual(
        DENIAL,
      );
    }
  });

  test("a working directory that is a link out of the project leaves its target to the session", async ($, on) => {
    world(on, {
      disk: new Map([
        [INSIDE.slice(0, -1), link("/elsewhere")],
        ["/elsewhere", DIR],
        ["/elsewhere/.bashrc", FILE],
      ]),
    });
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: "/elsewhere/.bashrc" } }),
    ).toEqual(ENGINE);
  });

  test("a folder whose stat is refused is not missing: nothing tells where the path lands", async ($, on) => {
    world(on, { disk: new Map([[`${INSIDE}l`, refused("a sandbox keeps plugins out of it")]]) });
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `${INSIDE}l/cli.ts` } }),
    ).toMatchObject({ decision: "deny", reason: expect.stringContaining("cannot tell where") });
  });

  test("a project at the root of the file system allows its working directory", async ($, on) => {
    world(on, {
      stored: storedSession(SERVER, "/"),
      disk: new Map([
        ["/plans", DIR],
        [`/plans/${DATE}`, DIR],
        [`/${WORKDIR}`.slice(0, -1), DIR],
      ]),
    });
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `/${WORKDIR}plan.md` } }),
    ).toEqual({ decision: "allow" });
  });

  test("a relative path hangs off the session's directory", async ($, on) => {
    world(on);
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    expect(
      await $.tool.check({ tool: "Edit", input: { file_path: `${WORKDIR}notes.md` } }),
    ).toEqual({ decision: "allow" });

    expect(
      await $.tool.check({ tool: "Edit", input: { file_path: `${WORKDIR}../escape.md` } }),
    ).toEqual(DENIAL);
  });

  test("NotebookEdit is read on notebook_path, and a tool that writes no file passes on", async ($, on) => {
    world(on);
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    expect(
      await $.tool.check({ tool: "NotebookEdit", input: { notebook_path: "src/n.ipynb" } }),
    ).toEqual(DENIAL);

    expect(editedPath("Bash", { command: "rm -rf /" })).toBeNull();
  });
});

describe("submitResult", () => {
  test("a version tells the model to end its turn, recorded or kept: it acts the same on both", () => {
    expect(submitResult({ version: 1, kept: false })).toEqual({
      result: "Plan v1 under review. End your turn.",
    });
    expect(submitResult({ version: 2, kept: true })).toEqual({
      result: "Plan v2 under review. End your turn.",
    });
  });

  test("an error is the deny the model reads", () => {
    expect(submitResult({ error: "write plan.md in x/ first" })).toEqual({
      deny: "write plan.md in x/ first",
    });
  });
});

/** Where a `stage` line whose workspace is `workspace`, as JSON, says the plan stands; `null` when it is no line. */
function stageOf(workspace: string) {
  const line = parseServerLine(`{"type":"stage","workspace":${workspace}}`);

  return line?.type === "stage" ? line.stage : null;
}

describe("parseServerLine", () => {
  test("ready names the server: its port, its token and its pid", () => {
    expect(parseServerLine(JSON.stringify(READY))).toEqual({
      type: "ready",
      info: SERVER,
      channel: CHANNEL,
    });
  });

  test("an approval's notes are a path or null", () => {
    const notes = `${FINAL}.review/v3.notes.md`;

    for (const entry of [approved(3, notes), approved(3)]) {
      expect(parseServerLine(JSON.stringify(channelLine({ seq: 2, entry })))).toEqual({
        type: "channel",
        line: { seq: 2, entry },
      });
    }
  });

  test("an approval whose notes are missing or no string is no line", () => {
    const { notes: _, ...bare } = approved(3);

    for (const entry of [bare, { ...bare, notes: 3 }]) {
      expect(
        parseServerLine(JSON.stringify({ type: "channel", line: { seq: 2, entry } })),
      ).toBeNull();
    }
  });

  test("an entry is numbered from 1", () => {
    expect(parseServerLine(JSON.stringify(channelLine({ seq: 0, entry: sent() })))).toBeNull();
  });

  test("the workspace is read as the band draws it: its kind, and the version once there is one", () => {
    expect(stageOf(JSON.stringify(DRAFTING))).toEqual({ kind: "drafting" });
    expect(stageOf(JSON.stringify(inReview(2)))).toEqual({ kind: "inReview", version: 2 });
    expect(stageOf('{"kind":"changesRequested","version":2}'), "a stage that is gone").toBeNull();
    expect(JSON.parse(JSON.stringify(stage(inReview(2))))).toMatchObject({ type: "stage" });
  });

  test("a line of another shape is none, for the caller to log", () => {
    expect(
      parseServerLine('{"pending":{"kind":"none"},"workspace":{"kind":"drafting"}}'),
    ).toBeNull();
    expect(parseServerLine("Listening on 4242")).toBeNull();
    expect(stageOf('{"kind":"inReview"}'), "no version").toBeNull();
    expect(stageOf('{"kind":"elsewhere","version":2}'), "an unknown kind").toBeNull();
  });
});

describe("parseChannel", () => {
  test("an answer the module does not read is an error, never no entry", () => {
    const unread = "GET /api/channel answered a shape this module does not read";

    expect(parseChannel(JSON.stringify([{ seq: 1, entry: sent() }]))).toEqual([
      { seq: 1, entry: sent() },
    ]);
    expect(() => parseChannel("{}"), "no list").toThrow(unread);
    expect(() => parseChannel('[{"seq":1,"entry":{"kind":"sent"}}]'), "no file").toThrow(unread);
  });
});
