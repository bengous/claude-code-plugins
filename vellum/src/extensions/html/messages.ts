import type { ElementRef } from "../../core/protocol.ts";

/** The contract across the sandbox: the page and the frame script both hold to it. */

export type PickBox = {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
};

/** `box` is in the frame's coordinates; the page adds the iframe's own rect. */
export type FrameToPage =
  | {
      readonly type: "vellum:pick";
      readonly elements: readonly ElementRef[];
      readonly box: PickBox;
    }
  | { readonly type: "vellum:unpick" }
  | { readonly type: "vellum:holding"; readonly holding: boolean };

/** The page's tokens the frame's overlay draws with, resolved to sRGB: its shadow root reads none of the page's properties. */
export type FrameTheme = {
  readonly redline: string;
  readonly marker: string;
  readonly sheet: string;
  readonly ink: string;
};

export type PageToFrame =
  | { readonly type: "vellum:method"; readonly method: "select" | "pinpoint" }
  | { readonly type: "vellum:holding"; readonly holding: boolean }
  | { readonly type: "vellum:comments"; readonly selectors: readonly string[] }
  | { readonly type: "vellum:theme"; readonly theme: FrameTheme }
  | { readonly type: "vellum:clear" };
