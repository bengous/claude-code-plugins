import type {
  Dispatched,
  Reading,
  Returned,
  ServerContext,
  ServerExtension,
  ServerWorkflow,
} from "../../extension.ts";
import type {
  ChannelEntry,
  ChannelLine,
  DocGroup,
  DocRef,
  GroupedDoc,
  ReviewView,
} from "../../protocol.ts";
import { readDraft } from "../adapters/draft.ts";
import {
  appendText,
  finalize as renameWorkspace,
  HELD_RETRY_MS,
  listFiles,
  listReview,
  modifiedAt,
  readPlan,
  readText,
  readTextIfAny,
  readWorkspace,
  removeFile,
  renameFile,
  writeText,
} from "../adapters/fs.ts";
import {
  appended,
  CHANNEL_FILE,
  CHANNEL_ID_FILE,
  channelAfter,
  nextSeq,
  renamedIn,
  untold,
} from "../domain/channel.ts";
import type { FinalDir, ProjectPath, Version, WipDir } from "../domain/paths.ts";
import { parseVersion } from "../domain/paths.ts";
import type { Draft } from "../domain/review.ts";
import { draftIsEmpty } from "../domain/review.ts";
import type {
  Actor,
  EventInput,
  PlanText,
  Stage,
  Table,
  Workflow,
  WorkflowView,
  Wording,
} from "../domain/workflow.ts";
import { JOURNAL_FILE, journalText, next, stageOf, tableOf, viewOf } from "../domain/workflow.ts";
import type { Memory, PlanWorkspace } from "../domain/workspace.ts";
import {
  DRAFT_FILE,
  legacyBatch,
  notesFile,
  PLAN_FILE,
  REVIEW_DIR,
  projectPath,
  takesComments,
  underReviewDir,
  versionFile,
  workspaceOf,
} from "../domain/workspace.ts";
import type { EffectPorts } from "./effects.ts";
import { interpret } from "./effects.ts";

export type ReviewOptions = {
  readonly project: string;
  readonly workdir: WipDir;
  readonly extensions: readonly ServerExtension[];
  /** What the directory cannot say at start: an approval already renamed it, for a server revived there. */
  readonly memory?: Memory | undefined;
  /** How long a rename held on Windows is retried; `HELD_RETRY_MS` when not given. Tests shorten it. */
  readonly heldRetryMs?: number | undefined;
};

/** A step the server ran, and whether an approval's rename that failed stopped its effects. */
export type Stepped = Dispatched & { readonly stopped: boolean };

/** How long `ServerContext.hold` holds a request: under the 30 s at which the engine cuts every `$.http.fetch` (`docs/plugin-testing/hook-runtime.md`). */
const WAIT_HOLD_MS = 25_000;

function grouped(docs: readonly DocRef[], group: DocGroup): GroupedDoc[] {
  return docs.map((doc) => ({ ...doc, group }));
}

/**
 * The queue, the workflow and its readers. Every step reads the workflow, lets `next` judge the
 * event against the table, and hands the effects to `interpret`, the one code that writes for the
 * workflow; then the page hears of it, and the waits read again. What a step reads before it is
 * judged is its route's (`events.ts` for the core's own), never a decision of this class.
 */
export class Review {
  private memory: Memory;

  /** The workflow the last step left, for what the disk does not say: a proposal's wait. */
  private last: Workflow | null = null;

  private readonly listeners = new Set<(stage: Stage) => void>();

  private readonly channelListeners = new Set<(line: ChannelLine) => void>();

  private queue: Promise<unknown> = Promise.resolve();

  private readonly waiters = new Set<() => void>();

  /** What each `returnToCall` handed a call, by the call. */
  private readonly returns = new Map<string, Returned>();

  private readonly parts: readonly { readonly id: string; readonly workflow: ServerWorkflow }[];

  /** The core's rows and the extensions', in the registry's order. */
  public readonly table: Table;

  /** How each extension words its region, in the registry's order. */
  private readonly wordings: readonly Wording[];

  /** What every extension reads through: bound here, since a step runs here. */
  public readonly context: ServerContext;

  private readonly ports: EffectPorts;

  public constructor(public readonly options: ReviewOptions) {
    const { project } = options;
    this.memory = options.memory ?? { kind: "none" };

    this.parts = options.extensions.flatMap(({ id, workflow }) =>
      workflow === undefined ? [] : [{ id, workflow }],
    );

    this.table = tableOf(this.parts.map(({ workflow }) => workflow));

    this.wordings = this.parts.map(({ id, workflow }) => ({
      id,
      segment: workflow.segment,
      line: workflow.line,
    }));

    this.context = {
      workspace: () => this.workspace(),
      listFiles: (dir) => listFiles(project, dir),
      readText: (path) => readTextIfAny(project, path),
      inOrder: (work) => this.inOrder(work),
      dispatch: (event, input, actor) => this.inOrder(() => this.step(event, input, actor)),
      workflow: () => this.workflow(),
      returned: (call) => this.returns.get(call) ?? null,
      draft: async () => {
        const draft = await this.draft();

        return draft === "unreadable" ? null : draft;
      },
      start: (id, input) => this.start(id, input),
      hold: (read, waiting) => this.hold(read, waiting),
    };

    this.ports = {
      recordVersion: () => this.recordVersion(),
      writeFile: async (file, text) => writeText(project, await this.doc(file), text),
      appendFile: async (file, text) => appendText(project, await this.doc(file), text),
      exists: async (file) => (await modifiedAt(project, await this.doc(file))) !== null,
      removeFile: async (file) => removeFile(project, await this.doc(file)),
      relay: (entry) => this.relay(entry),
      returnToCall: (call, seq, text) => {
        this.returns.set(call, { seq, text });
        this.wake();
      },
      approveDirectory: (dir, notes) => this.approveDirectory(dir, notes),
      journal: async (line) =>
        appendText(project, await this.doc(JOURNAL_FILE), journalText(line, new Date())),
      log: (text) => console.error(text),
    };
  }

  /** One chain for every mutation, so a gate never writes its version under a grill that opened meanwhile. */
  public inOrder<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work);
    this.queue = done.catch(() => null);

    return done;
  }

  /**
   * One step, inside the queue: the workflow read, the input read off it, stamped with the time
   * and the channel's next number, judged by `next`, interpreted. A step that passed wakes the
   * waits and tells the listeners the workflow `next` answered, which the effects made true; a
   * rename that stopped left the memory ahead of it, so that one is read again.
   */
  public async step(event: string, input: EventInput | Reading, actor: Actor): Promise<Stepped> {
    const w = await this.workflow();
    // oxlint-disable-next-line unicorn/no-instanceof-builtins -- a Reading and plain values both come from this process's own routes, never another realm: `instanceof` tells them apart.
    const read = input instanceof Function ? await input(w) : input;
    const channel = await readTextIfAny(this.options.project, await this.doc(CHANNEL_FILE));
    const stamped = { at: new Date().toISOString(), seq: String(nextSeq(channel ?? "")), ...read };
    const stepped = next(w, this.table, event, stamped, actor);
    const { appended: told, stopped } = await interpret(stepped.effects, this.ports);

    if (!stopped) this.last = stepped.workflow;

    if (stepped.verdict.kind === "allow") {
      this.wake();

      if (stopped) await this.notify();
      else this.tell(stepped.workflow);
    }

    return { ...stepped, appended: told, stopped };
  }

  /** The workflow as it stands: the directory with the memory, `plan.md` against its last version, each region. */
  public async workflow(): Promise<Workflow> {
    const workspace = await this.workspace();
    const planText = await this.planTextOf(workspace);

    const regions = await Promise.all(
      this.parts.map(({ id, workflow }) =>
        workflow.region(this.context, this.last?.regions.find((one) => one.id === id) ?? null),
      ),
    );

    return { workspace, planText, regions };
  }

  private async planTextOf(workspace: PlanWorkspace): Promise<PlanText> {
    const plan = await readTextIfAny(
      this.options.project,
      projectPath(`${workspace.dir}${PLAN_FILE}`),
    );

    if (plan === null) return "absent";

    if (workspace.kind === "drafting") return "pending";

    return plan === (await this.planText(workspace.version, workspace.dir)) ? "none" : "pending";
  }

  private async hold<T>(read: () => Promise<T>, waiting: (value: T) => boolean): Promise<T> {
    const until = Date.now() + WAIT_HOLD_MS;

    for (;;) {
      const value = await read();
      const left = until - Date.now();

      if (!waiting(value) || left <= 0) return value;

      await new Promise<void>((resolve) => {
        const woken = (): void => {
          clearTimeout(timer);
          this.waiters.delete(woken);
          resolve();
        };

        const timer = setTimeout(woken, left);
        this.waiters.add(woken);
      });
    }
  }

  /** Wakes every held request to read again: a step may have settled it. */
  private wake(): void {
    for (const waiter of this.waiters) waiter();
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` is handed on untouched to the extension it names, whose `parse.ts` reads it.
  private async start(id: string, input: unknown): Promise<string> {
    const extension = this.options.extensions.find((one) => one.id === id);

    if (extension?.start === undefined) throw new Error(`no extension ${id} starts`);

    return await extension.start(this.context, input);
  }

  public subscribe(listener: (stage: Stage) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  public async workspace(): Promise<PlanWorkspace> {
    const disk = await readWorkspace(this.options.project, this.options.workdir);

    if (!disk.ok) throw new Error(disk.error);

    return workspaceOf(disk.value, this.memory);
  }

  /** Hears every entry the channel takes, as it is written. */
  public onChannel(listener: (line: ChannelLine) => void): () => void {
    this.channelListeners.add(listener);

    return () => this.channelListeners.delete(listener);
  }

  /** The channel's entries past `after`, read from where the review lives now. */
  public async channel(after: number): Promise<ChannelLine[]> {
    const text = await readTextIfAny(this.options.project, await this.doc(CHANNEL_FILE));

    return channelAfter(text ?? "", after);
  }

  /**
   * Opens the channel where the review lives, and answers its identity, minted the first time. A
   * channel already there takes the entries its directory implies and it lacks (`untold`); a
   * directory with no channel yet has nothing to tell, since its files predate the channel.
   */
  public openChannel(): Promise<string> {
    return this.inOrder(async () => {
      const { project } = this.options;
      await this.migrateFeedback();
      const workspace = await this.workspace();
      const text = await readTextIfAny(project, await this.doc(CHANNEL_FILE));

      if (text === null) await writeText(project, await this.doc(CHANNEL_FILE), "");
      else {
        const names = await listReview(project, workspace.dir);

        for (const entry of untold(workspace, names, channelAfter(text, 0)))
          await this.relay(entry);
      }

      const idDoc = await this.doc(CHANNEL_ID_FILE);
      const id = (await readTextIfAny(project, idDoc))?.trim() ?? "";

      if (id !== "") return id;
      const minted = crypto.randomUUID();
      await writeText(project, idDoc, minted);

      return minted;
    });
  }

  /**
   * A feedback file of vellum before 0.14.5, `v<N>.feedback.md`, becomes that version's first
   * batch, and the channel's entries name it there: its entry stays told, and the repair tells no
   * file twice. Runs before the channel opens, on the directory the server serves.
   */
  private async migrateFeedback(): Promise<void> {
    const { project } = this.options;
    const { dir } = await this.workspace();
    const channel = await this.doc(CHANNEL_FILE);

    for (const name of await listReview(project, dir)) {
      const batch = legacyBatch(name);

      if (batch === null) continue;
      const from = projectPath(`${dir}${REVIEW_DIR}/${name}`);
      const to = projectPath(`${dir}${REVIEW_DIR}/${batch}`);
      await renameFile(project, from, to);
      const text = await readTextIfAny(project, channel);

      if (text !== null) await writeText(project, channel, renamedIn(text, from, to));
    }
  }

  /** A file of the plan's directory, where the review lives now: the approval moves it. */
  private async doc(file: string): Promise<ProjectPath> {
    return projectPath(`${(await this.workspace()).dir}${file}`);
  }

  /** Inside the queue, so two entries never take one number. */
  private async relay(entry: ChannelEntry): Promise<number> {
    const { project } = this.options;
    const doc = await this.doc(CHANNEL_FILE);
    const { text, seq } = appended((await readTextIfAny(project, doc)) ?? "", entry);
    await appendText(project, doc, text);

    for (const listener of this.channelListeners) listener({ seq, entry });

    return seq;
  }

  private planDoc(version: Version, dir: WipDir | FinalDir = this.options.workdir): ProjectPath {
    return projectPath(`${dir}${versionFile(version)}`);
  }

  /** The text of `version`, under the directory where the review lives. */
  public planText(version: Version, dir?: WipDir | FinalDir): Promise<string> {
    return readText(this.options.project, this.planDoc(version, dir));
  }

  /** `plan.md` as the next version; a failed approval's memory goes with the version it named. */
  private async recordVersion(): Promise<void> {
    const { project, workdir } = this.options;
    const plan = await readPlan(project, workdir);

    if (plan === null) throw new Error(`${PLAN_FILE} is gone from ${workdir}`);
    const workspace = await this.workspace();
    const version = parseVersion(workspace.kind === "drafting" ? 1 : workspace.version + 1);

    if (!version.ok) throw new Error(version.error);
    await writeText(project, this.planDoc(version.value), plan);
    this.memory = { kind: "none" };
  }

  /**
   * The approval of the version under review, as `approve()` ran it: the notes before the rename,
   * which carries them, and the draft's removal, so it never ships in the final directory; the
   * approved text back in `plan.md`, since Claude may have revised the working copy past it; the
   * rename to `dir`, which rewrites the links; the memory. A rename that fails keeps its error
   * for the page, which retries from there.
   */
  private async approveDirectory(dir: FinalDir, notes: string | null): Promise<boolean> {
    const { project, workdir } = this.options;
    const workspace = await this.workspace();

    if (workspace.kind !== "inReview") throw new Error("no version is under review to approve");
    const { version } = workspace;

    // A `null` writes nothing and keeps a notes file already there: a retry carries no note.
    if (notes !== null)
      await writeText(project, projectPath(`${workdir}${notesFile(version)}`), notes);
    await removeFile(project, this.draftDoc());
    await writeText(project, projectPath(`${workdir}${PLAN_FILE}`), await this.planText(version));
    const heldRetryMs = this.options.heldRetryMs ?? HELD_RETRY_MS;
    const renamed = await renameWorkspace(project, workdir, dir, heldRetryMs);

    if (!renamed.ok) {
      this.memory = { kind: "finalizeError", version, error: renamed.error };

      return false;
    }

    const final = await readWorkspace(project, renamed.value);
    const noted = final.ok && final.value.kind === "approved" && final.value.notes;
    this.memory = { kind: "approved", version, dir: renamed.value, notes: noted };

    return true;
  }

  /**
   * The page's unsent work as it was last saved, `null` when there is none, through the one parser
   * a `PUT` goes through: a malformed draft is `unreadable`, never read half-way.
   */
  public async draft(): Promise<Draft | "unreadable" | null> {
    const saved = await readTextIfAny(this.options.project, this.draftDoc());

    return saved === null ? null : (readDraft(saved) ?? "unreadable");
  }

  /**
   * Replaces the saved draft, and tells no listener. An empty one removes the file, in any state.
   * One with content is kept only where comments are taken, `false` elsewhere: no decision would
   * remove it, and after an approval the write would bring the renamed working directory back.
   */
  public async saveDraft(draft: Draft): Promise<boolean> {
    const { project } = this.options;

    if (draftIsEmpty(draft)) {
      await removeFile(project, this.draftDoc());

      return true;
    }

    if (!takesComments(await this.workspace())) return false;
    await writeText(project, this.draftDoc(), JSON.stringify(draft));

    return true;
  }

  /** What the draft keeps after a Send: the file goes with the last of it. */
  public async keepDraft(rest: Draft): Promise<void> {
    const { project } = this.options;

    if (draftIsEmpty(rest)) await removeFile(project, this.draftDoc());
    else await writeText(project, this.draftDoc(), JSON.stringify(rest));
  }

  private draftDoc(): ProjectPath {
    return projectPath(`${this.options.workdir}${DRAFT_FILE}`);
  }

  /**
   * Tells every listener where the review stands, read again: a file changed under the server,
   * which calls it in the queue so no step is read half-way.
   */
  public async notify(): Promise<Stage> {
    return this.tell(await this.workflow());
  }

  private tell(w: Workflow): Stage {
    const stage = stageOf(w, this.wordings);

    for (const listener of this.listeners) listener(stage);

    return stage;
  }

  /**
   * The plan's directory's files in every state, the final directory's once approved, the
   * linked docs that live outside it after. Once a version exists the reviewer decides on it,
   * so the working copy `plan.md` leaves the list; while drafting it is the draft the reviewer
   * may comment on. The workflow goes as a reader takes it, its files left out.
   */
  public async view(): Promise<ReviewView> {
    const w = await this.workflow();
    const { workspace } = w;
    const listed = await listFiles(this.options.project, workspace.dir);
    const planFile = projectPath(`${workspace.dir}${PLAN_FILE}`);

    const files = grouped(
      listed.filter((file) => file.path !== planFile),
      "artifact",
    );

    if (workspace.kind === "drafting") {
      const plans = grouped(
        listed.filter((file) => file.path === planFile),
        "plan",
      );

      return {
        workspace,
        plan: null,
        docs: [...plans, ...files],
        workflow: this.viewed(w),
      };
    }

    const doc = this.planDoc(workspace.version, workspace.dir);
    const text = await this.planText(workspace.version, workspace.dir);
    const before = parseVersion(workspace.version - 1);

    const previous = before.ok
      ? { version: before.value, text: await this.planText(before.value, workspace.dir) }
      : null;

    const linked = grouped(await this.linkedDocs(text, doc, workspace.dir, listed), "cited");

    return {
      workspace,
      plan: { doc, text, workingCopy: planFile, previous },
      docs: [...files, ...linked],
      workflow: this.viewed(w),
    };
  }

  /** The workflow as a reader takes it, each region in its extension's words: `GET /api/workflow`. */
  public viewed(w: Workflow): WorkflowView {
    return viewOf(w, this.table, this.wordings);
  }

  private async linkedDocs(
    plan: string,
    planDoc: ProjectPath,
    dir: WipDir | FinalDir,
    listed: readonly DocRef[],
  ): Promise<DocRef[]> {
    const { project } = this.options;
    const roots = { project, planDir: dir };
    const seen = new Set<string>([planDoc, ...listed.map((doc) => doc.path)]);
    const docs: DocRef[] = [];

    for (const extension of this.options.extensions) {
      for (const doc of extension.linkedDocs?.(plan, roots) ?? []) {
        if (seen.has(doc.path) || underReviewDir(doc.path)) continue;
        const modified = await modifiedAt(project, doc.path);

        if (modified === null) continue;
        seen.add(doc.path);
        docs.push({ ...doc, modified });
      }
    }

    return docs;
  }
}
