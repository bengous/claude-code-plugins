import type { ComponentChildren, JSX, RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * The page's components, each one a class of `style.css` spelled in one place: what every
 * button, badge, chip, tag, banner, popover, dialog, chevron, gear, handle and switch of the core and
 * of the extensions is drawn with.
 */

export type ButtonProps = Omit<
  JSX.IntrinsicElements["button"],
  "size" | "class" | "className" | "ref"
> & {
  readonly variant?: "default" | "send" | "grill";
  readonly size?: "md" | "sm";
  readonly class?: string | undefined;
};

function classes(...names: readonly (string | false | undefined)[]): string {
  return names.filter((name) => name !== false && name !== undefined && name !== "").join(" ");
}

/** A `title` given as `undefined` leaves no attribute: Preact would write an empty one, since the DOM has the property. */
export function Button(props: ButtonProps): JSX.Element {
  const { variant = "default", size = "md", class: extra, title, children, ...rest } = props;

  return (
    <button
      type="button"
      {...rest}
      {...(title === undefined ? {} : { title })}
      class={classes("btn", variant !== "default" && variant, size === "sm" && "sm", extra)}
    >
      {children}
    </button>
  );
}

export function Badge(props: { readonly children: ComponentChildren }): JSX.Element {
  return <span class="badge">{props.children}</span>;
}

export type ChipProps = Omit<JSX.IntrinsicElements["button"], "class" | "className" | "ref"> & {
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

/** A chip that shows a label and takes no click: `Chip` is a button. */
export function Tag(props: { readonly children: ComponentChildren }): JSX.Element {
  return <span class="chip">{props.children}</span>;
}

export type BannerKind = "sent" | "ok" | "err" | "info";

export function Banner(props: {
  readonly kind: BannerKind;
  /** `alert` for what went wrong, `status` otherwise: the default. */
  readonly role?: "status" | "alert";
  /** The one button a banner offers, after its text. */
  readonly action?: { readonly label: string; readonly run: () => void } | undefined;
  readonly children: ComponentChildren;
}): JSX.Element {
  return (
    <div class={`banner ${props.kind}`} role={props.role ?? "status"}>
      {props.children}
      {props.action !== undefined && (
        <Button size="sm" onClick={props.action.run}>
          {props.action.label}
        </Button>
      )}
    </div>
  );
}

const FOCUSABLE =
  "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]";

export type PopoverProps = {
  /** What the dialog is, for assistive technology. */
  readonly label: string;
  readonly top?: number;
  readonly left?: number;
  /** While a target is being added, the popover fades and lets the pointer through. */
  readonly through?: boolean;
  readonly class?: string | undefined;
  /** The popover's element, for a caller that measures it. */
  readonly box?: RefObject<HTMLDivElement>;
  /** Escape anywhere in the page, or a pointer down outside the popover. The focus goes back to the element that held it at the opening. */
  readonly onClose: () => void;
  /** Ctrl+Enter or ⌘+Enter, from any field of the popover. */
  readonly onSubmit?: () => void;
  readonly children: ComponentChildren;
};

let popovers = 0;

/** Whether a popover is up: a modal opened over one would take the focus from what it holds. */
export function popoverUp(): boolean {
  return popovers > 0;
}

/**
 * At the opening the focus enters: on the `autofocus` element, else the first focusable one. It
 * scrolls nothing: the popover is placed where it is seen, and a focus that scrolls would move the
 * pane before the placement lands.
 */
export function Popover(props: PopoverProps): JSX.Element {
  const own = useRef<HTMLDivElement>(null);
  const box = props.box ?? own;
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    popovers += 1;

    return () => {
      popovers -= 1;
    };
  }, []);

  useEffect(() => {
    const element = box.current;

    if (element === null) return;
    const opener = document.activeElement;
    (
      element.querySelector<HTMLElement>("[autofocus]") ??
      element.querySelector<HTMLElement>(FOCUSABLE)
    )?.focus({ preventScroll: true });

    // Escape is heard on the document: the focus may have left the popover, for a click on the
    // sheet or a Tab past its last button, and the dialog must still close from the keyboard.
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      latest.current.onClose();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) latest.current.onSubmit?.();
    };

    // A pointer let through to add a target must not close what it adds to.
    const onPointerDown = (event: PointerEvent): void => {
      if (latest.current.through === true) return;

      if (event.target instanceof Node && element.contains(event.target)) return;
      latest.current.onClose();
    };

    element.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onEscape, true);
    document.addEventListener("pointerdown", onPointerDown, true);

    return () => {
      element.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onEscape, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      const active = document.activeElement;
      const left = active === null || active === document.body || element.contains(active);

      if (left && opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  const style: JSX.CSSProperties = {};

  if (props.top !== undefined) style.top = `${props.top}px`;

  if (props.left !== undefined) style.left = `${props.left}px`;

  return (
    <div
      class={classes("popover", props.through === true && "through", props.class)}
      role="dialog"
      aria-label={props.label}
      style={style}
      ref={box}
    >
      {props.children}
    </div>
  );
}

export type DialogProps = {
  /** What the dialog is, for assistive technology. */
  readonly label: string;
  readonly class?: string;
  /** Escape, a click on the backdrop, or a close the page did not ask for. */
  readonly onCancel: () => void;
  /** Under the card, on the backdrop: the shortcuts. */
  readonly below?: ComponentChildren;
  readonly children: ComponentChildren;
};

/**
 * A modal `<dialog>`, shown while it is mounted: `showModal()` on mount, `close()` on unmount.
 * The browser dims the page, makes it inert, keeps the focus inside and gives it back to the
 * opener at the close. The dialog element spans the window and the card sits in it, so a click
 * on the backdrop lands on the element itself; it counts when the pointer went down there too,
 * and a drag that starts in the card closes nothing.
 */
let dialogs = 0;

/** Whether a modal is up: another opened over it would stack and take its focus. */
export function dialogUp(): boolean {
  return dialogs > 0;
}

export function Dialog(props: DialogProps): JSX.Element {
  const box = useRef<HTMLDialogElement>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    dialogs += 1;

    return () => {
      dialogs -= 1;
    };
  }, []);

  useEffect(() => {
    const element = box.current;

    if (element === null) return;
    element.showModal();
    let downOnBackdrop = false;

    // Prevented, so Preact stays the one to close it; a close that gets through anyway is a
    // cancel too, so the element and the page never disagree.
    const onCancel = (event: Event): void => {
      event.preventDefault();
      latest.current.onCancel();
    };

    const onClose = (): void => latest.current.onCancel();

    const onPointerDown = (event: PointerEvent): void => {
      downOnBackdrop = event.target === element;
    };

    const onClick = (event: MouseEvent): void => {
      if (downOnBackdrop && event.target === element) latest.current.onCancel();
      downOnBackdrop = false;
    };

    element.addEventListener("cancel", onCancel);
    element.addEventListener("close", onClose);
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("click", onClick);

    return () => {
      element.removeEventListener("cancel", onCancel);
      element.removeEventListener("close", onClose);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("click", onClick);
      element.close();
    };
  }, []);

  return (
    <dialog ref={box} class={classes("dialog", props.class)} aria-label={props.label}>
      <div class="dialog-card">{props.children}</div>
      {props.below !== undefined && <div class="dialog-below">{props.below}</div>}
    </dialog>
  );
}

/** A side panel's fold control, on the panel's edge: the panel's name above a chevron that points where the panel goes. */
export function Handle(props: {
  /** Which of the page's two panels: "left" follows `--rail-width`, "right" `--comments-width`. */
  readonly side: "left" | "right";
  readonly open: boolean;
  /** The id of the panel it folds. */
  readonly controls: string;
  /** The panel's name, written on the handle. */
  readonly name: string;
  /** The accessible name, when it says more than `name`: the comments' count. */
  readonly label?: string;
  /** The click, so a caller can read where the handle was before it moves with the panel. */
  readonly onToggle: (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
  /** What a folded panel still shows: the comments' badge. */
  readonly children?: ComponentChildren;
}): JSX.Element {
  return (
    <button
      type="button"
      class={`handle ${props.side}`}
      aria-controls={props.controls}
      aria-expanded={props.open}
      aria-label={props.label ?? props.name}
      onClick={props.onToggle}
    >
      {props.children}
      <span class="name">{props.name}</span>
      <Chevron />
    </button>
  );
}

/** An icon: `currentColor`, the size of the text beside it unless its holder sets one, rotated to point. */
export function Chevron(): JSX.Element {
  return (
    <svg class="chevron" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="M3.5 1.5 L7 5 L3.5 8.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/**
 * The settings' icon: `currentColor`, the size of the text beside it. The path is Lucide's
 * `settings` icon, ISC licence, copyright Lucide Contributors (https://lucide.dev/license).
 */
export function Gear(): JSX.Element {
  return (
    <svg class="gear" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** A state, on or off, where a `Button` is an action: its label names what it turns on. */
export function Switch(props: {
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly children: ComponentChildren;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      class="switch"
      onClick={props.onChange}
    >
      <span class="track" />
      {props.children}
    </button>
  );
}

let brush: CanvasRenderingContext2D | null = null;

/**
 * A token resolved to sRGB, for every consumer that parses neither `color-mix()` nor `oklab()`:
 * `getPropertyValue` returns the `color-mix()` expression as written, and once computed on an
 * element Chrome serializes `oklab(…)`. Mermaid and the sandboxed frame refuse both; the pixel of
 * a 1×1 canvas is the one path that yields sRGB whatever the colour space.
 */
export function srgb(token: `--${string}`): string {
  brush ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });

  if (brush === null) throw new Error(`no 2d canvas context to resolve ${token} with`);
  const probe = document.createElement("div");
  probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(token).trim();

  if (probe.style.color === "") throw new Error(`${token} is not a colour token of :root`);
  document.body.append(probe);
  brush.fillStyle = getComputedStyle(probe).color;
  probe.remove();
  brush.fillRect(0, 0, 1, 1);
  const [r, g, b] = brush.getImageData(0, 0, 1, 1).data;

  return `rgb(${r}, ${g}, ${b})`;
}
