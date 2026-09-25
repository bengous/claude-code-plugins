import { useEffect, useRef, useState } from "preact/hooks";

import type { RendererProps, PageExtension } from "../../core/extension.ts";
import { docUrl } from "../../core/page/api.ts";
import { Composer } from "../../core/page/composer.tsx";
import { srgb } from "../../core/page/kit.tsx";
import type { Rect } from "../../core/page/place.ts";
import { windowOf } from "../../core/page/place.ts";
import {
  choices,
  choose,
  commenting,
  dark,
  flipCommentSwitch,
  holding,
} from "../../core/page/state.ts";
import type { ElementRef } from "../../core/protocol.ts";
import type { Chosen, CommentedPlace, FrameTheme, PageToFrame, PickBox } from "./messages.ts";
import { parseFrameToPage } from "./parse.ts";

type Draft = {
  readonly elements: readonly [ElementRef, ...ElementRef[]];
  readonly box: PickBox;
};

/** The frame's box in the scrolled pane, and the pane's window there, for the composer's placement. */
function placeOf(frame: HTMLIFrameElement, box: PickBox): { target: Rect; pane: Rect } | null {
  const pane = frame.parentElement;

  if (pane === null) return null;
  const rect = frame.getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();

  return {
    target: {
      top: box.top + rect.top - paneRect.top + pane.scrollTop,
      left: box.left + rect.left - paneRect.left + pane.scrollLeft,
      width: box.width,
      height: box.height,
    },
    pane: windowOf(pane),
  };
}

function themeOf(): FrameTheme {
  return {
    redline: srgb("--redline"),
    marker: srgb("--marker"),
    sheet: srgb("--sheet"),
    ink: srgb("--ink"),
    outline: srgb("--outline"),
  };
}

function HtmlDoc(props: RendererProps): preact.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [frameHolding, setFrameHolding] = useState(false);
  const on = commenting.value;
  const held = holding.value;
  const night = dark.value;

  const places: readonly CommentedPlace[] = props.annotations.flatMap((annotation) =>
    annotation.anchor.kind === "element" ? annotation.anchor.elements : [],
  );

  const chosen: readonly Chosen[] = Object.entries(choices.value[props.doc.path] ?? {}).map(
    ([decision, { option }]) => ({ decision, option }),
  );

  const post = (message: PageToFrame): void =>
    frame.current?.contentWindow?.postMessage(message, "*");

  useEffect(() => {
    post({ type: "vellum:commenting", on });

    if (!on) setDraft(null);
  }, [on]);

  useEffect(() => post({ type: "vellum:holding", holding: held }), [held]);

  useEffect(() => post({ type: "vellum:theme", theme: themeOf() }), [night]);

  useEffect(
    () => post({ type: "vellum:commented", places }),
    [JSON.stringify(places), props.doc.path],
  );

  useEffect(
    () => post({ type: "vellum:chosen", choices: chosen }),
    [JSON.stringify(chosen), props.doc.path],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = parseFrameToPage(event.data);

      if (message === null) return;

      if (message.type === "vellum:unpick") setDraft(null);

      if (message.type === "vellum:holding") setFrameHolding(message.holding);

      if (message.type === "vellum:switch") flipCommentSwitch();

      if (message.type === "vellum:choose" && !commenting.value) {
        const { decision, option, description } = message;
        choose(props.doc.path, decision, { option, description });
      }

      if (message.type === "vellum:pick" && commenting.value) {
        const [first, ...rest] = message.elements;

        setDraft(first === undefined ? null : { elements: [first, ...rest], box: message.box });
      }
    };

    window.addEventListener("message", onMessage);

    return () => window.removeEventListener("message", onMessage);
  }, [props.doc.path]);

  // The focus goes back to the mockup, where the pick was made.
  const close = (): void => {
    setDraft(null);
    post({ type: "vellum:clear" });
    frame.current?.focus();
  };

  const at = frame.current === null || draft === null ? null : placeOf(frame.current, draft.box);
  const adding = (held || frameHolding) && draft !== null;

  return (
    <>
      <iframe
        title={props.doc.path}
        ref={frame}
        sandbox="allow-scripts"
        src={docUrl(props.doc)}
        onLoad={() => {
          post({ type: "vellum:theme", theme: themeOf() });
          post({ type: "vellum:commenting", on });
          post({ type: "vellum:commented", places });
          post({ type: "vellum:chosen", choices: chosen });
        }}
        onPointerLeave={() => post({ type: "vellum:leave" })}
      />
      {draft !== null && at !== null && (
        <Composer
          doc={props.doc.path}
          picks={draft.elements.map((element) => ({
            key: JSON.stringify(element),
            element,
          }))}
          through={adding}
          target={at.target}
          pane={at.pane}
          onCancel={close}
          onSubmit={(mark) => {
            props.annotate({
              doc: props.doc.path,
              anchor: { kind: "element", elements: draft.elements },
              mark,
            });
            close();
          }}
        />
      )}
    </>
  );
}

export const htmlPage: PageExtension = {
  id: "html",
  renderers: [{ accepts: (doc) => doc.mediaType === "text/html", component: HtmlDoc }],
};
