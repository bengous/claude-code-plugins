import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";

import type { CommitSha } from "../../protocol.ts";
import { Button } from "../kit.tsx";
import { vellumBuild } from "../state.ts";
import { SettingsGroup, SettingsRow } from "./rows.tsx";

const COPIED_MS = 1200;

const COPY_LABEL = { idle: "Copy", copied: "Copied", failed: "Not copied" } as const;

type CopyState = keyof typeof COPY_LABEL;

function CopyCommit(props: { readonly commit: CommitSha }): JSX.Element {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), COPIED_MS);

    return () => clearTimeout(timer);
  }, [state]);

  const copy = (): void => {
    void navigator.clipboard.writeText(props.commit).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };

  return (
    <Button size="sm" onClick={copy}>
      {COPY_LABEL[state]}
    </Button>
  );
}

/** The running plugin's version and commit, as the server read them at its start. */
export function AboutVellum(): JSX.Element {
  const build = vellumBuild.value;

  if (build !== null && !build.ok) {
    return (
      <SettingsGroup title="Build">
        <p class="settings-error">
          <code>{build.reason ?? `HTTP ${build.status}`}</code>
        </p>
      </SettingsGroup>
    );
  }

  const value = build?.value;

  return (
    <SettingsGroup title="Build">
      <SettingsRow label="Version" description="From the plugin's manifest.">
        <code>{value?.version ?? ""}</code>
      </SettingsRow>
      <SettingsRow label="Commit" description="The commit this copy of Vellum comes from.">
        <code title={value?.commit}>{value?.commit.slice(0, 8) ?? ""}</code>
        {value !== undefined && <CopyCommit commit={value.commit} />}
      </SettingsRow>
    </SettingsGroup>
  );
}
