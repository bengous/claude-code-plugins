import type { ServerContext, ServerExtension } from "../../extension.ts";
import type {
  ChannelEntry,
  ChannelLine,
  DocGroup,
  DocRef,
  GroupedDoc,
  ReviewView,
} from "../../protocol.ts";
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
  writeText,
} from "../adapters/fs.ts";
import {
  appended,
  CHANNEL_FILE,
  CHANNEL_ID_FILE,
  channelAfter,
  untold,
} from "../domain/channel.ts";
import type { FeedbackHeading } from "../domain/feedback.ts";
import { formatFeedback } from "../domain/feedback.ts";
import type { FinalDir, ProjectPath, Version, WipDir } from "../domain/paths.ts";
import { parseVersion } from "../domain/paths.ts";
import type { Decision, Draft } from "../domain/review.ts";
import { decideOn, draftIsEmpty, gateVersion, slugFor } from "../domain/review.ts";
import type { Memory, PlanWorkspace } from "../domain/workspace.ts";
import {
  DRAFT_FILE,
  notesFile,
  PLAN_FILE,
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

function grouped(docs: readonly DocRef[], group: DocGroup): GroupedDoc[] {
  return docs.map((doc) => ({ ...doc, group }));
}

/** The use case: reads the directory, lets the domain decide, applies: files, memory, listeners. */
export class Review {
  private memory: Memory;

  private readonly listeners = new Set<(workspace: PlanWorkspace) => void>();

  private readonly channelListeners = new Set<(line: ChannelLine) => void>();

  private queue: Promise<unknown> = Promise.resolve();

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

  /** The page's unsent work as it was last saved, `null` when there is none: stored, never read into. */
  public draft(): Promise<string | null> {
    return readTextIfAny(this.options.project, this.draftDoc());
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

    if (decision.kind === "feedback" && (await this.held()) !== null) {
      return { ok: false, workspace };
    }

    const latestText =
      workspace.kind === "drafting" ? null : await this.planText(workspace.version, workspace.dir);

    const decided = decideOn(workspace, latestText, decision);

    if (decided.kind === "refused") return { ok: false, workspace };
    const { project, workdir } = this.options;

    // `plan.md` first: if the version's write fails, the next gate records the edit as the next version.
    if (decided.kind !== "draftFeedback" && decided.edit !== null) {
      await writeText(project, projectPath(`${workdir}${PLAN_FILE}`), decided.edit.text);
      await writeText(project, decided.edit.path, decided.edit.text);
    }

    // Before the rename, which rewrites its links and carries it to the final directory.
    if (decided.kind === "approve" && decided.notes !== null) {
      await writeText(project, decided.notes.path, decided.notes.text);
    }

    // Before the rename too, or the draft ships in the final directory.
    await removeFile(project, this.draftDoc());

    if (decided.kind === "approve") return await this.approve(decided.version);

    if (decision.kind === "feedback") {
      const heading: FeedbackHeading =
        decided.kind === "draftFeedback"
          ? { kind: "draft", batch: decided.batch }
          : { kind: "review", version: decided.version, editedFrom: decided.editedFrom };

      const annotations =
        decided.kind === "draftFeedback" ? decision.annotations : decided.annotations;

      await writeText(project, decided.path, formatFeedback(annotations, heading));
      await this.relay({ kind: "sent", file: decided.path });
    }

    return { ok: true, workspace: await this.notify() };
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
