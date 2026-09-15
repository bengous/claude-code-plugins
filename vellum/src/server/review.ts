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
import { parseProjectPath } from "../workspace/paths.ts";
import { readWorkspace, versionFile } from "../workspace/read.ts";
import type { Memory } from "./transitions.ts";
import { decideOn, gateVersion, pendingOf, slugFor, workspaceOf } from "./transitions.ts";

export type ReviewOptions = {
  readonly project: string;
  readonly workdir: WipDir;
  readonly plugins: readonly ServerPlugin[];
};

export type DecisionResult =
  | { readonly ok: true; readonly workspace: PlanWorkspace }
  | { readonly ok: false; readonly workspace: PlanWorkspace };

export type FinalizeResult =
  | { readonly ok: true; readonly workspace: PlanWorkspace; readonly plan: string }
  | { readonly ok: false; readonly workspace: PlanWorkspace };

/** Reads the directory, lets `transitions.ts` decide, applies: files, memory, listeners. */
export class Review {
  private memory: Memory = { kind: "none" };

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

  public async workspace(): Promise<PlanWorkspace> {
    const disk = await readWorkspace(this.options.project, this.options.workdir);

    if (!disk.ok) throw new Error(disk.error);

    return workspaceOf(disk.value, this.memory, this.options.workdir);
  }

  public async pending(): Promise<Pending> {
    return pendingOf(await this.workspace());
  }

  private planDoc(version: Version, dir: WipDir | FinalDir = this.options.workdir): ProjectPath {
    const parsed = parseProjectPath(`${dir}${versionFile(version)}`);

    if (!parsed.ok) throw new Error(parsed.error);

    return parsed.value;
  }

  private async planText(version: Version, dir?: WipDir | FinalDir): Promise<string> {
    return await Bun.file(join(this.options.project, this.planDoc(version, dir))).text();
  }

  private async notify(): Promise<PlanWorkspace> {
    const workspace = await this.workspace();

    for (const listener of this.listeners) listener(workspace);

    return workspace;
  }

  public async gate(input: GateInput): Promise<Version> {
    const workspace = await this.workspace();
    this.planFilePath = input.planFilePath;

    const latestText =
      workspace.kind === "drafting" || workspace.kind === "finalizing"
        ? null
        : await this.planText(workspace.version, workspace.dir);

    const gated = gateVersion(workspace, latestText, input.plan);

    if (gated.kind === "kept") return gated.version;
    await Bun.write(join(this.options.project, this.planDoc(gated.version)), input.plan);
    this.memory = { kind: "none" };
    await this.notify();

    return gated.version;
  }

  public async decide(decision: Decision): Promise<DecisionResult> {
    const workspace = await this.workspace();
    const decided = decideOn(workspace, decision);

    if (decided.kind === "refused") return { ok: false, workspace };

    if (decided.kind === "approve") {
      this.memory = decided.memory;
    } else if (decision.kind === "feedback") {
      const text = formatFeedback(decision.annotations, decided.version);
      await Bun.write(join(this.options.project, decided.path), text);
    }

    return { ok: true, workspace: await this.notify() };
  }

  public async finalize(version: Version): Promise<FinalizeResult> {
    const before = await this.workspace();

    if (before.kind !== "approvedPending" || before.version !== version) {
      return { ok: false, workspace: before };
    }

    const plan = await this.planText(version);
    const slug = slugFor(plan, this.planFilePath);

    if (!slug.ok) return this.failFinalize(version, slug.error);
    const renamed = await renameWorkspace(this.options.project, before.dir, slug.value);

    if (!renamed.ok) return this.failFinalize(version, renamed.error);
    this.memory = { kind: "approved", version, dir: renamed.value };

    return {
      ok: true,
      workspace: await this.notify(),
      plan: rewriteLinks(plan, before.dir, renamed.value),
    };
  }

  /** The reviewer sees the error and retries from the page; until then nothing is pending. */
  private async failFinalize(version: Version, error: string): Promise<FinalizeResult> {
    this.memory = { kind: "finalizeError", version, error };

    return { ok: false, workspace: await this.notify() };
  }

  public async view(): Promise<ReviewView> {
    const workspace = await this.workspace();

    if (workspace.kind === "drafting" || workspace.kind === "finalizing") {
      return { workspace, plan: null, docs: [] };
    }

    const doc = this.planDoc(workspace.version, workspace.dir);
    const text = await this.planText(workspace.version, workspace.dir);

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
