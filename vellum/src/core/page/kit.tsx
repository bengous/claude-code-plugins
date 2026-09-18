import type { ComponentChildren, JSX } from "preact";

/**
 * The page's components, each one a class of `style.css` spelled in one place: what every
 * button, badge, chip, banner and popover of the core and of the extensions is drawn with.
 */

export type ButtonProps = Omit<JSX.IntrinsicElements["button"], "size" | "class" | "className"> & {
  readonly variant?: "default" | "send" | "grill";
  readonly size?: "md" | "sm";
  readonly class?: string | undefined;
};

function classes(...names: readonly (string | false | undefined)[]): string {
  return names.filter((name) => name !== false && name !== undefined && name !== "").join(" ");
}

export function Button(props: ButtonProps): JSX.Element {
  const { variant = "default", size = "md", class: extra, children, ...rest } = props;

  return (
    <button
      type="button"
      {...rest}
      class={classes("btn", variant !== "default" && variant, size === "sm" && "sm", extra)}
    >
      {children}
    </button>
  );
}

export function Badge(props: { readonly children: ComponentChildren }): JSX.Element {
  return <span class="badge">{props.children}</span>;
}

export type ChipProps = Omit<JSX.IntrinsicElements["button"], "class" | "className"> & {
  readonly tone?: "default" | "del";
};

export function Chip(props: ChipProps): JSX.Element {
  const { tone = "default", children, ...rest } = props;

  return (
    <button type="button" {...rest} class={classes("chip", tone === "del" && "del")}>
      {children}
    </button>
  );
}

export type BannerKind = "sent" | "ok" | "err";

export function Banner(props: {
  readonly kind: BannerKind;
  readonly children: ComponentChildren;
}): JSX.Element {
  return (
    <div class={`banner ${props.kind}`} role="status">
      {props.children}
    </div>
  );
}

export function Popover(props: {
  /** What the dialog is, for assistive technology. */
  readonly label: string;
  readonly top?: number;
  readonly left?: number;
  /** While a target is being added, the popover fades and lets the pointer through. */
  readonly through?: boolean;
  readonly class?: string | undefined;
  readonly children: ComponentChildren;
}): JSX.Element {
  const style: JSX.CSSProperties = {};

  if (props.top !== undefined) style.top = `${props.top}px`;

  if (props.left !== undefined) style.left = `${props.left}px`;

  return (
    <div
      class={classes("popover", props.through === true && "through", props.class)}
      role="dialog"
      aria-label={props.label}
      style={style}
    >
      {props.children}
    </div>
  );
}

let brush: CanvasRenderingContext2D | null = null;

/**
 * A token resolved to sRGB, for every consumer that parses neither `color-mix()` nor `oklab()`:
 * `getPropertyValue` returns the `color-mix()` expression as written, and once computed on an
 * element Chrome serializes `oklab(…)`. Mermaid and the sandboxed frame refuse both; the pixel of
 * a 1×1 canvas is the one path that yields sRGB whatever the colour space.
 */
export function srgb(token: string): string {
  brush ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });

  if (brush === null) throw new Error(`no 2d canvas context to resolve ${token} with`);
  const probe = document.createElement("div");
  probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  document.body.append(probe);
  brush.fillStyle = getComputedStyle(probe).color;
  probe.remove();
  brush.fillRect(0, 0, 1, 1);
  const [r, g, b] = brush.getImageData(0, 0, 1, 1).data;

  return `rgb(${r}, ${g}, ${b})`;
}
