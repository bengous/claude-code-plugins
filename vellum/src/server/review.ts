import { dirname, join, relative } from "node:path";

import { formatFeedback } from "../feedback/format.ts";
import type {
  Decision,
  DocRef,
  GateInput,
  Pending,
  PlanWorkspace,
  ReviewView,
  ServerPlugin,
} from "../protocol.ts";
import { finalize as renameWorkspace } from "../workspace/finalize.ts";
import { rewriteLinks } from "../workspace/links.ts";
import type { FinalDir, ProjectPath, Version, WipDir } from "../workspace/paths.ts";
import { parseProjectPath, parseVersion } from "../workspace/paths.ts";
import { feedbackFile, readWorkspace, versionFile } from "../workspace/read.ts";
import { slugFromFileName, slugFromTitle } from "../workspace/slug.ts";

export type ReviewOptions = {
  readonly project: string;
  readonly workdir: WipDir;
  readonly plugins: readonly ServerPlugin[];
};

/** What the directory cannot say: the steps between Approve and the rename, and a rename that failed. */
type Memory =
  | { readonly kind: "none" }
  | { readonly kind: "approvedPending"; readonly version: Version }
  | { readonly kind: "finalizing"; readonly version: Version; readonly to: FinalDir }
  | { readonly kind: "finalizeError"; readonly version: Version; readonly error: string }
  | { readonly kind: "approved"; readonly version: Version; readonly dir: FinalDir };

export type DecisionResult =
  | { readonly ok: true; readonly workspace: PlanWorkspace }
  | { readonly ok: false; readonly workspace: PlanWorkspace };

export type FinalizeResult =
  | { readonly ok: true; readonly workspace: PlanWorkspace; readonly plan: string }
  | { readonly ok: false; readonly workspace: PlanWorkspace };

export class Review {
  private memory: Memory = { kind: "none" };

  private pending: Pending = { kind: "none" };

  private planFilePath: string | null = null;

  private readonly listeners = new Set<(workspace: PlanWorkspace) => void>();

  public constructor(private readonly options: ReviewOptions) {}

  public subscribe(listener: (workspace: PlanWorkspace) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  public get listenerCount(): number {
    return this.listeners.size;
  }

  public pendingNow(): Pending {
    return this.pending;
  }

  public async workspace(): Promise<PlanWorkspace> {
    const { memory } = this;

    if (memory.kind === "approved") {
      return { kind: "approved", dir: memory.dir, version: memory.version };
    }

    if (memory.kind === "finalizing") {
      return {
        kind: "finalizing",
        from: this.options.workdir,
        to: memory.to,
        version: memory.version,
      };
    }

    const disk = await readWorkspace(this.options.project, this.options.workdir);

    if (!disk.ok) throw new Error(disk.error);

    if (disk.value.kind === "inReview" && memory.kind === "approvedPending") {
      return { kind: "approvedPending", dir: disk.value.dir, version: disk.value.version };
    }

    if (disk.value.kind === "inReview" && memory.kind === "finalizeError") {
      return { ...disk.value, finalizeError: memory.error };
    }

    return disk.value;
  }

  private planDoc(version: Version, dir: WipDir | FinalDir = this.options.workdir): ProjectPath {
    const parsed = parseProjectPath(`${dir}${versionFile(version)}`);

    if (!parsed.ok) throw new Error(parsed.error);

    return parsed.value;
  }

  private async planText(version: Version, dir?: WipDir | FinalDir): Promise<string> {
    return await Bun.file(join(this.options.project, this.planDoc(version, dir))).text();
  }

  private latestVersion(workspace: PlanWorkspace): Version | null {
    return workspace.kind === "drafting" ? null : workspace.version;
  }

  private async notify(): Promise<void> {
    const workspace = await this.workspace();

    for (const listener of this.listeners) listener(workspace);
  }

  /**
   * Records the submitted plan as the next version. The same text as a version still under review
   * keeps its number (a repeated call, or the approval's second call); after a feedback the
   * resubmission is a new round, artifacts may have changed while the text did not.
   */
  public async gate(input: GateInput): Promise<Version> {
    const workspace = await this.workspace();
    const latest = this.latestVersion(workspace);
    this.planFilePath = input.planFilePath;

    if (
      latest !== null &&
      workspace.kind !== "changesRequested" &&
      (await this.planText(latest)) === input.plan
    ) {
      return latest;
    }

    const next = parseVersion((latest ?? 0) + 1);

    if (!next.ok) throw new Error(next.error);
    await Bun.write(join(this.options.project, this.planDoc(next.value)), input.plan);
    this.memory = { kind: "none" };
    this.pending = { kind: "none" };
    await this.notify();

    return next.value;
  }

  public async decide(decision: Decision): Promise<DecisionResult> {
    const workspace = await this.workspace();

    if (workspace.kind !== "inReview") return { ok: false, workspace };

    if (decision.kind === "approve") {
      this.memory = { kind: "approvedPending", version: workspace.version };
      this.pending = { kind: "approved", version: workspace.version };
    } else {
      const path = parseProjectPath(`${workspace.dir}${feedbackFile(workspace.version)}`);

      if (!path.ok) throw new Error(path.error);
      await Bun.write(
        join(this.options.project, path.value),
        formatFeedback(decision.annotations, workspace.version),
      );
      this.pending = { kind: "feedback", version: workspace.version, path: path.value };
    }

    await this.notify();

    return { ok: true, workspace: await this.workspace() };
  }

  public async finalize(version: Version): Promise<FinalizeResult> {
    const before = await this.workspace();

    if (before.kind !== "approvedPending" || before.version !== version) {
      return { ok: false, workspace: before };
    }

    const plan = await this.planText(version);

    const slug = slugFromTitle(plan).ok
      ? slugFromTitle(plan)
      : slugFromFileName(this.planFilePath ?? "plan.md");

    if (!slug.ok) return this.failFinalize(version, slug.error);
    const renamed = await renameWorkspace(this.options.project, before.dir, slug.value);

    if (!renamed.ok) return this.failFinalize(version, renamed.error);

    this.memory = { kind: "approved", version, dir: renamed.value };
    this.pending = { kind: "none" };
    await this.notify();

    return {
      ok: true,
      workspace: await this.workspace(),
      plan: rewriteLinks(plan, before.dir, renamed.value),
    };
  }

  /** The reviewer sees the error and retries from the page; until then nothing is pending. */
  private async failFinalize(version: Version, error: string): Promise<FinalizeResult> {
    this.memory = { kind: "finalizeError", version, error };
    this.pending = { kind: "none" };
    await this.notify();

    return { ok: false, workspace: await this.workspace() };
  }

  public async view(): Promise<ReviewView> {
    const workspace = await this.workspace();
    const version = this.latestVersion(workspace);

    if (version === null || workspace.kind === "finalizing") {
      return { workspace, plan: null, docs: [] };
    }

    const doc = this.planDoc(version, workspace.dir);
    const text = await this.planText(version, workspace.dir);

    return { workspace, plan: { doc, text }, docs: await this.linkedDocs(text, doc) };
  }

  private async linkedDocs(plan: string, planDoc: ProjectPath): Promise<DocRef[]> {
    const { project } = this.options;

    const planDir =
      this.planFilePath === null ? join(project, this.options.workdir) : dirname(this.planFilePath);

    const roots = { project, planDir: relative(project, planDir) || "." };
    const seen = new Set<string>([planDoc]);
    const docs: DocRef[] = [];

    for (const plugin of this.options.plugins) {
      for (const doc of plugin.linkedDocs?.(plan, roots) ?? []) {
        if (seen.has(doc.path)) continue;

        if (!(await Bun.file(join(project, doc.path)).exists())) continue;
        seen.add(doc.path);
        docs.push(doc);
      }
    }

    return docs;
  }
}
