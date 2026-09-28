import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";

import type { VellumBuild } from "../../protocol.ts";
import type { Fetched } from "../api.ts";
import { fetchVellumBuild } from "../api.ts";
import { SettingsGroup, SettingsRow } from "./rows.tsx";

/**
 * The running plugin's version and commit, read at each opening: a server revived under the same
 * tab after an update is another build, and a failed read is tried again.
 */
export function AboutVellum(): JSX.Element {
  const [build, setBuild] = useState<Fetched<VellumBuild> | null>(null);

  useEffect(() => {
    void fetchVellumBuild().then(setBuild, (cause: unknown) =>
      setBuild({ ok: false, status: 0, reason: `The build could not be read: ${String(cause)}` }),
    );
  }, []);

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
        <code>{value?.commit ?? ""}</code>
      </SettingsRow>
    </SettingsGroup>
  );
}
