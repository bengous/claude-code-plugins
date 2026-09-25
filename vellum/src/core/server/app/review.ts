import type { Part, ServerContext, ServerExtension, Started } from "../../extension.ts";
import type {
  ChannelEntry,
  ChannelLine,
  DocGroup,
  DocRef,
  GroupedDoc,
  ReviewView,
  SendRefusal,
} from "../../protocol.ts";
import { readDraft } from "../adapters/draft.ts";
import {
  appendText,
  finalize as renameWorkspace,
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
  renamedIn,
  untold,
} from "../domain/channel.ts";
import { formatBatch } from "../domain/feedback.ts";
import type { FinalDir, ParseResult, ProjectPath, Version, WipDir } from "../domain/paths.ts";
import { parseVersion } from "../domain/paths.ts";
import type { Decision, Draft, SendRequest } from "../domain/review.ts";
import {
  decideOn,
  draftIsEmpty,
  EMPTY_DRAFT,
  gateVersion,
  sendOn,
  slugFor,
} from "../domain/review.ts";
import type { Memory, PlanWorkspace } from "../domain/workspace.ts";
import {
  batchesOf,
  batchFile,
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

export type ReviewOptions = {
  readonly project: string;
  readonly workdir: WipDir;
  readonly extensions: readonly ServerExtension[];
  /** What the directory cannot say at start: an approval already renamed it, for a server revived there. */
  readonly memory?: Memory | undefined;
};

export type DecisionResult =
  | { readonly ok: true; readonly workspace: PlanWorkspace }
  | { readonly ok: false; readonly workspace: PlanWorkspace };

/** What a Send did: the batch written and its entry's number, or why nothing was written. */
export type SendResult =
  | { readonly ok: true; readonly file: ProjectPath; readonly seq: number }
  | { readonly ok: false; readonly refusal: SendRefusal };

/** What `submit` reads: the version the plan is, or why the browser has nothing to show. */
export type GateResult =
  | { readonly ok: true; readonly version: Version; readonly kept: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * What a submit does with a `plan.md` whose text is the version under review: `record` opens a
 * new version after a feedback, as the model's explicit call means it; `keep` never does, as
 * the turn's end means nothing new.
 */
export type GateOptions = { readonly unchanged: "record" | "keep" };

const RECORD_UNCHANGED: GateOptions = { unchanged: "record" };

const HELD_GATE = "the plan is submitted once the reviewer ends it";

/** How long `ServerContext.hold` holds a request: under the 30 s at which the engine cuts every `$.http.fetch` (`docs/plugin-testing/hook-runtime.md`). */
const WAIT_HOLD_MS = 25_000;

const NO_PART: Part = { kind: "none" };

function grouped(docs: readonly DocRef[], group: DocGroup): GroupedDoc[] {
  return docs.map((doc) => ({ ...doc, group }));
}

/** The use case: reads the directory, lets the domain decide, applies: files, memory, listeners. */
export class Review {
  private memory: Memory;

  private readonly listeners = new Set<(workspace: PlanWorkspace) => void>();

  private readonly channelListeners = new Set<(line: ChannelLine) => void>();

  private queue: Promise<unknown> = Promise.resolve();

  private readonly waiters = new Set<() => void>();

  /** What every extension reads and writes through: bound here, since `holds` and `approved` are called here. */
  public readonly context: ServerContext;

  public constructor(private readonly options: ReviewOptions) {
    const { project } = options;
    this.memory = options.memory ?? { kind: "none" };

    this.context = {
      workspace: () => this.workspace(),
      listFiles: (dir) => listFiles(project, dir),
      readText: (path) => readTextIfAny(project, path),
      writeText: (path, text) => writeText(project, path, text),
      notify: async () => {
        await this.notify();
      },
      inOrder: (work) => this.inOrder(work),
      relay: (entry) => this.relay(entry),
      draft: async () => {
        const draft = await this.draft();

        return draft === "unreadable" ? null : draft;
      },
      start: (id, input) => this.start(id, input),
      held: () => this.held(),
      hold: (read, waiting) => this.hold(read, waiting),
      wake: () => {
        for (const waiter of this.waiters) waiter();
      },
    };
  }

  /** One chain for every mutation, so a gate never writes its version under a grill that opened meanwhile. */
  private inOrder<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work);
    this.queue = done.catch(() => null);

    return done;
  }

  /** The first extension that holds the review says what holds it. */
  private async held(): Promise<string | null> {
    for (const extension of this.options.extensions) {
      const reason = (await extension.holds?.(this.context)) ?? null;

      if (reason !== null) return reason;
    }

    return null;
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

  /** Called inside the queue, from another extension's route: no step of its own. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` is handed on untouched to the extension it names, whose `parse.ts` reads it.
  private async start(id: string, input: unknown): Promise<ParseResult<Started>> {
    const extension = this.options.extensions.find((one) => one.id === id);

    if (extension?.start === undefined) return { ok: false, error: `no extension ${id} starts` };

    return await extension.start(this.context, input);
  }

  public subscribe(listener: (workspace: PlanWorkspace) => void): () => void {
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
    const text = await readTextIfAny(this.options.project, await this.channelDoc(CHANNEL_FILE));

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
      const text = await readTextIfAny(project, await this.channelDoc(CHANNEL_FILE));

      if (text === null) await writeText(project, await this.channelDoc(CHANNEL_FILE), "");
      else {
        const names = await listReview(project, workspace.dir);

        for (const entry of untold(workspace, names, channelAfter(text, 0)))
          await this.relay(entry);
      }

      const idDoc = await this.channelDoc(CHANNEL_ID_FILE);
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
    const channel = await this.channelDoc(CHANNEL_FILE);

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

  private async channelDoc(file: string): Promise<ProjectPath> {
    return projectPath(`${(await this.workspace()).dir}${file}`);
  }

  /** Called inside the queue, by the core and through `ServerContext`, so two entries never take one number. */
  private async relay(entry: ChannelEntry): Promise<number> {
    const { project } = this.options;
    const doc = await this.channelDoc(CHANNEL_FILE);
    const { text, seq } = appended((await readTextIfAny(project, doc)) ?? "", entry);
    await appendText(project, doc, text);

    for (const listener of this.channelListeners) listener({ seq, entry });

    return seq;
  }

  private planDoc(version: Version, dir: WipDir | FinalDir = this.options.workdir): ProjectPath {
    return projectPath(`${dir}${versionFile(version)}`);
  }

  private planText(version: Version, dir?: WipDir | FinalDir): Promise<string> {
    return readText(this.options.project, this.planDoc(version, dir));
  }

  /**
   * The page's unsent work as it was last saved, `null` when there is none, through the one parser
   * a `PUT` goes through: a draft of an older shape is `unreadable`, never read half-way.
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

  private draftDoc(): ProjectPath {
    return projectPath(`${this.options.workdir}${DRAFT_FILE}`);
  }

  /** Tells every listener the workspace again; the server calls it when a file changes under it. */
  public async notify(): Promise<PlanWorkspace> {
    const workspace = await this.workspace();

    for (const listener of this.listeners) listener(workspace);

    return workspace;
  }

  /** The plan the model wrote is the version under review; the same text keeps its number. */
  public gate(options: GateOptions = RECORD_UNCHANGED): Promise<GateResult> {
    return this.inOrder(() => this.gateInOrder(options));
  }

  private async gateInOrder(options: GateOptions): Promise<GateResult> {
    const held = await this.held();

    if (held !== null) return { ok: false, error: `${held}: ${HELD_GATE}` };
    const workspace = await this.workspace();

    if (workspace.kind === "approved") {
      return { ok: false, error: `plan v${workspace.version} is already approved` };
    }

    const plan = await readPlan(this.options.project, this.options.workdir);

    if (plan === null) {
      return { ok: false, error: `write ${PLAN_FILE} in ${this.options.workdir} first` };
    }

    const latestText =
      workspace.kind === "drafting" ? null : await this.planText(workspace.version, workspace.dir);

    if (workspace.kind !== "drafting" && options.unchanged === "keep" && latestText === plan) {
      return { ok: true, version: workspace.version, kept: true };
    }

    const gated = gateVersion(workspace, latestText, plan);

    if (gated.kind === "kept") return { ok: true, version: gated.version, kept: true };
    await writeText(this.options.project, this.planDoc(gated.version), plan);
    this.memory = { kind: "none" };
    await this.notify();

    return { ok: true, version: gated.version, kept: false };
  }

  public decide(decision: Decision): Promise<DecisionResult> {
    return this.inOrder(() => this.decideInOrder(decision));
  }

  private async decideInOrder(decision: Decision): Promise<DecisionResult> {
    const workspace = await this.workspace();

    const latestText =
      workspace.kind === "drafting" ? null : await this.planText(workspace.version, workspace.dir);

    const decided = decideOn(workspace, latestText, decision);

    if (decided.kind === "refused") return { ok: false, workspace };
    const { project, workdir } = this.options;

    // `plan.md` first: if the version's write fails, the next gate records the edit as the next version.
    if (decided.edit !== null) {
      await writeText(project, projectPath(`${workdir}${PLAN_FILE}`), decided.edit.text);
      await writeText(project, decided.edit.path, decided.edit.text);
    }

    // Before the rename, which rewrites its links and carries it to the final directory.
    if (decided.notes !== null) await writeText(project, decided.notes.path, decided.notes.text);

    // Before the rename too, or the draft ships in the final directory.
    await removeFile(project, this.draftDoc());

    return await this.approve(decided.version);
  }

  /**
   * One Send: the comments and the edit it names, as the reviewer saw them at the click, read from
   * the saved draft, and the extensions' parts. It changes no stage and is never held: the page
   * takes comments after it.
   */
  public send(request: SendRequest): Promise<SendResult> {
    return this.inOrder(() => this.sendInOrder(request));
  }

  /**
   * All in one step of the queue. Decided first, with nothing written: `sendOn` and every part.
   * Then the edit, the batch, and its entry, the commit point: before it a failure removes the
   * batch, so nothing is told of a Send the page saw fail; after it nothing throws, so the page
   * never sends again what Claude already has. Then the draft's rest and each part's `commit`: the
   * grill's round closes only once the batch and its entry exist.
   */
  private async sendInOrder(request: SendRequest): Promise<SendResult> {
    const workspace = await this.workspace();

    if (workspace.kind === "approved") return { ok: false, refusal: { reason: "approved" } };
    const stored = await this.draft();

    if (stored === "unreadable") return { ok: false, refusal: { reason: "unreadable" } };
    const draft = stored ?? EMPTY_DRAFT;

    const latestText =
      workspace.kind === "drafting" ? null : await this.planText(workspace.version, workspace.dir);

    const decided = sendOn(workspace, latestText, draft, request);

    if (decided.kind === "refused") return { ok: false, refusal: { reason: decided.reason } };
    const parts: { readonly id: string; readonly part: Extract<Part, { kind: "part" }> }[] = [];
    const unanswered: string[] = [];

    for (const extension of request.parts ? this.options.extensions : []) {
      const part = (await extension.part?.(this.context, draft, request.takeDefaults)) ?? NO_PART;

      if (part.kind === "unanswered") unanswered.push(...part.ids);
      else if (part.kind === "part") parts.push({ id: extension.id, part });
    }

    if (unanswered.length > 0)
      return { ok: false, refusal: { reason: "unanswered", ids: unanswered } };
    const { annotations, edit, version, editedFrom } = decided;

    if (annotations.length === 0 && edit === null && parts.length === 0) {
      return { ok: false, refusal: { reason: "empty" } };
    }

    const { project, workdir } = this.options;

    // `plan.md` first: if the version's write fails, the next gate records the edit as the next version.
    if (edit !== null) {
      await writeText(project, projectPath(`${workdir}${PLAN_FILE}`), edit.text);
      await writeText(project, edit.path, edit.text);
    }

    const batch = batchesOf(await listReview(project, workspace.dir), version) + 1;
    const file = projectPath(`${workspace.dir}${batchFile(version, batch)}`);

    const heading =
      version === null
        ? { kind: "draft" as const, batch }
        : { kind: "review" as const, version, batch, editedFrom };

    const texts = parts.map(({ part }) => part.text);
    const seq = await this.commitBatch(file, formatBatch(heading, texts, annotations));
    const typed = parts.reduce((kept, { part }) => part.typed(kept), decided.rest.typed);
    await this.afterCommit("the draft's rest", () => this.keepDraft({ ...decided.rest, typed }));
    const comments = annotations.length > 0 || edit !== null;

    for (const { id, part } of parts) {
      const more = comments || parts.some((other) => other.id !== id);
      await this.afterCommit(`${id}'s commit`, () => part.commit({ file, seq, more }));
    }

    await this.afterCommit("notify", async () => {
      await this.notify();
    });

    return { ok: true, file, seq };
  }

  /** The batch, then its entry: the Send's commit point. A batch whose entry failed is removed. */
  private async commitBatch(file: ProjectPath, text: string): Promise<number> {
    const { project } = this.options;
    await writeText(project, file, text);

    try {
      return await this.relay({ kind: "sent", file });
    } catch (cause) {
      await removeFile(project, file);
      throw cause;
    }
  }

  /** Past the commit point the Send stands: a write that fails is logged, never the Send's failure. */
  private async afterCommit(what: string, work: () => Promise<void>): Promise<void> {
    await work().catch((cause: unknown) => {
      console.error(`a Send was committed, then ${what} failed: ${String(cause)}`);
    });
  }

  /** What the draft keeps after a Send: the file goes with the last of it. */
  private async keepDraft(rest: Draft): Promise<void> {
    const { project } = this.options;

    if (draftIsEmpty(rest)) await removeFile(project, this.draftDoc());
    else await writeText(project, this.draftDoc(), JSON.stringify(rest));
  }

  /**
   * Approve is the whole finalization: the approved text back in `plan.md`, since Claude may
   * have revised the working copy past it, links rewritten, directory renamed, nothing pending after.
   */
  private async approve(version: Version): Promise<DecisionResult> {
    const { project, workdir } = this.options;
    const approved = await this.planText(version);
    const slug = slugFor(approved);

    if (!slug.ok) return await this.failApprove(version, slug.error);
    await writeText(project, projectPath(`${workdir}${PLAN_FILE}`), approved);
    const renamed = await renameWorkspace(project, workdir, slug.value);

    if (!renamed.ok) return await this.failApprove(version, renamed.error);
    const final = await readWorkspace(project, renamed.value);
    const notes = final.ok && final.value.kind === "approved" && final.value.notes;
    this.memory = { kind: "approved", version, dir: renamed.value, notes };

    for (const extension of this.options.extensions) {
      // The plan is approved whatever an extension fails to close: the rename is done.
      await extension.approved?.(this.context).catch((cause: unknown) => {
        console.error(`${extension.id} failed on approved: ${String(cause)}`);
      });
    }

    const dir = renamed.value;
    const notesDoc = notes ? projectPath(`${dir}${notesFile(version)}`) : null;
    await this.relay({ kind: "approved", version, dir, notes: notesDoc });

    return { ok: true, workspace: await this.notify() };
  }

  /** The reviewer sees the error and retries from the page; until then nothing is pending. */
  private async failApprove(version: Version, error: string): Promise<DecisionResult> {
    this.memory = { kind: "finalizeError", version, error };

    return { ok: false, workspace: await this.notify() };
  }

  /**
   * The plan's directory's files in every state, the final directory's once approved, the
   * linked docs that live outside it after. Once a version exists the reviewer decides on it,
   * so the working copy `plan.md` leaves the list; while drafting it is the draft the reviewer
   * may comment on.
   */
  public async view(): Promise<ReviewView> {
    const workspace = await this.workspace();
    const listed = await listFiles(this.options.project, workspace.dir);

    const held = await this.held();

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

      return { workspace, plan: null, docs: [...plans, ...files], held };
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
      held,
    };
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
