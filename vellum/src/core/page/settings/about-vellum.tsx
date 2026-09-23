import type { JSX } from "preact";

import { vellumBuild } from "../state.ts";
import { SettingsGroup, SettingsRow } from "./rows.tsx";

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
      </SettingsRow>
    </SettingsGroup>
  );
}
