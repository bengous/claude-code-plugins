import type { JSX, ReactNode } from "react";

/** What a section is made of: a titled block of rows. */
export function SettingsGroup(props: {
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="settings-group">
      <h4>{props.title}</h4>
      <div className="settings-rows">{props.children}</div>
    </div>
  );
}

/** One setting: its label and what it does on the left, its control or its value on the right. */
export function SettingsRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="srow">
      <div>
        <div className="srow-label">{props.label}</div>
        {props.description !== undefined && <div className="srow-desc">{props.description}</div>}
      </div>
      <div className="srow-control">{props.children}</div>
    </div>
  );
}
