import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { RendererProps, PageExtension } from "../../core/extension.ts";
import { parseLines, passageFromRange, rangeFor } from "../../core/page/anchoring.ts";
import { docUrl } from "../../core/page/api.ts";
import { Composer } from "../../core/page/composer.tsx";
import { paint } from "../../core/page/highlights.ts";
import type { Rect } from "../../core/page/place.ts";
import { windowOf } from "../../core/page/place.ts";
import { dragRange, SHEET_ATTRIBUTE, selectedRange, toggled } from "../../core/page/selection.ts";
import {
  commenting,
  dark,
  docs,
  fail,
  focused,
  holding,
  planDoc,
  resume,
  review,
  select,
  succeed,
} from "../../core/page/state.ts";
import type { DocRef, Passage } from "../../core/protocol.ts";
import { changesOf } from "./changes.ts";
import { linkedDoc } from "./links.ts";
import { markedIndices } from "./marked.ts";
import { drawDiagrams } from "./mermaid.ts";
import type { Target } from "./pinpoint.ts";
import { boxOf, diagramPassage, targetAt, targetOf, targetRange } from "./pinpoint.ts";
import { waitingText } from "./sheet.ts";
import { toTree } from "./tree.ts";
import { removedBlock, toVNodes } from "./vnode.ts";

type Chosen = { readonly range: Range; readonly passage: Passage };

function rangesOf(root: HTMLElement, passages: readonly Passage[]): Range[] {
  return passages.flatMap((passage) => {
    const range = rangeFor(root, passage);

    return range === null ? [] : [range];
  });
}

/** A diagram is boxed where text is highlighted: its passage quotes source the SVG lacks. A code block is boxed as well when focused. */
function box(root: HTMLElement, name: string, passages: readonly Passage[]): void {
  const lines = new Set(passages.map((passage) => passage.lines.join("-")));

  for (const block of root.querySelectorAll<HTMLElement>("figure.mermaid, pre")) {
    block.classList.toggle(name, lines.has(block.dataset.lines ?? ""));
  }
}

/** Where a passage is on screen: its text's block, or the figure that stands for it. */
function blockOf(root: HTMLElement, passage: Passage): HTMLElement | null {
  const start = rangeFor(root, passage)?.startContainer;
  const from = start instanceof Element ? start : (start?.parentElement ?? null);

  return (
    from?.closest<HTMLElement>("[data-lines]") ??
    [...root.querySelectorAll<HTMLElement>("[data-lines]")].find(
      (block) => block.dataset.lines === passage.lines.join("-"),
    ) ??
    null
  );
}

/** The chosen places, and the last one's box in the pane's scrolled content, where the composer is placed near. */
type Draft = {
  readonly chosen: readonly [Chosen, ...Chosen[]];
  readonly target: Rect;
};

type Wash = { readonly target: Target } & Rect;

/** `rect`, from the viewport into the scrolled content of the pane around `root`. */
function inPane(root: HTMLElement, rect: DOMRect): Rect | null {
  const pane = root.parentElement;

  if (pane === null) return null;
  const paneRect = pane.getBoundingClientRect();

  return {
    top: rect.top - paneRect.top + pane.scrollTop,
    left: rect.left - paneRect.left + pane.scrollLeft,
    width: rect.width,
    height: rect.height,
  };
}

function draftOf(
  root: HTMLElement,
  chosen: readonly [Chosen, ...Chosen[]],
  rect: DOMRect,
): Draft | null {
  const target = inPane(root, rect);

  return target === null ? null : { chosen, target };
}

/** The block holding `passage`, made focusable: where the focus goes once the composer closes. */
function focusPassage(root: HTMLElement, passage: Passage): void {
  const block = blockOf(root, passage);

  if (block === null) return;

  if (!block.hasAttribute("tabindex")) block.tabIndex = -1;
  block.focus({ preventScroll: true });
}

/** The blocks Tab stops on while the switch is on, each a target Enter picks whole: what a click on it picks. */
const FOCUSABLE_BLOCKS =
  "p, li, h1, h2, h3, h4, h5, h6, pre, figure.mermaid, blockquote, tr, td, th";

/** A key or a button: whether the place adds to the chosen ones, as Ctrl+click does. */
type Modifiers = { readonly ctrlKey: boolean; readonly metaKey: boolean };

/** `range`, cut to what `root` holds of it: a drag released past the sheet selected the page after it too. */
function clampTo(root: HTMLElement, range: Range): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode();
  let last = first;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) last = node;

  if (first === null || last === null) return;

  if (!root.contains(range.startContainer)) range.setStart(first, 0);

  if (!root.contains(range.endContainer)) range.setEnd(last, last.textContent?.length ?? 0);
}

function linesAt(block: HTMLElement): readonly [number, number] {
  return parseLines(block.dataset.lines) ?? [0, 0];
}

/** Every diagram drawn and every image decoded, a broken one included: the sheet has its height. */
async function drawn(root: HTMLElement, night: boolean): Promise<void> {
  await drawDiagrams(root, night);

  await Promise.all(
    [...root.querySelectorAll("img")].map((image) => image.decode().catch(() => {})),
  );
}

/** A diagram stands for its source block, a code block for its whole text; every other target for the text it shows. */
function passageOf(root: HTMLElement, target: Target, range: Range): Passage | null {
  if (target.kind === "diagram") {
    return diagramPassage(target.element.dataset.lines, target.element.dataset.source);
  }

  const passage = passageFromRange(root, range);

  return passage !== null && target.kind === "code" ? { ...passage, kind: "code" } : passage;
}

/**
 * Off, a link to a document the page holds switches the view, and any other link opens in a new
 * tab. On, a click on a link picks it.
 */
function onClick(event: MouseEvent): void {
  if (commenting.value) return;
  const link = event.target instanceof Element ? event.target.closest("a") : null;
  const wanted = link?.dataset.path;

  if (wanted === undefined) return;
  const target = linkedDoc(wanted, docs.value, review.value?.plan ?? null);

  if (target === null) return;
  event.preventDefault();
  select(target);
}

/** The document's text, or `null` with the failure in the notices: an error page is not the document. */
async function sourceOf(doc: DocRef): Promise<string | null> {
  const name = doc.path.split("/").at(-1) ?? doc.path;

  try {
    const response = await fetch(docUrl(doc));

    if (response.ok) {
      succeed("load");

      return await response.text();
    }

    fail("load", `${name} could not be loaded: the server answered ${response.status}.`);
  } catch {
    fail("load", `${name} could not be loaded: the server did not answer.`);
  }

  return null;
}

function MarkdownDoc(props: RendererProps): preact.JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [drafted, setDraft] = useState<Draft | null>(null);
  const on = commenting.value;
  // A switch turned off, or a page that locks, under an open composer closes it: its comment
  // could not be added.
  const draft = on ? drafted : null;
  const [wash, setWash] = useState<Wash | null>(null);
  const container = useRef<HTMLElement>(null);
  // The click that ends a drag, which picks nothing whether the drag made a place or not.
  const swallow = useRef(false);
  // A drag that began in the sheet: its release is heard on the document, wherever it lands.
  const dragging = useRef(false);

  const shown = props.source ?? text;
  const listed = docs.value;
  const plan = review.value?.plan ?? null;
  // Every workspace event loads a new view: the sheet is drawn again, its diagrams with it, only
  // when a path a link may reach changed.
  const reachable = [plan?.doc, plan?.workingCopy, ...listed.map((doc) => doc.path)].join("\n");

  const content = useMemo(() => {
    if (shown === null) return null;
    const tree = toTree(shown);
    const changes = props.changes === null ? null : changesOf(tree, props.changes);
    const sheet = { changes, docs: listed, plan };

    const atEnd = (changes?.removedAtEnd ?? []).map((run) => removedBlock(run));

    return [...toVNodes(tree.children, sheet), ...atEnd];
  }, [shown, props.changes, reachable]);

  useEffect(() => {
    void sourceOf(props.doc).then((source) => {
      setFailed(source === null);

      if (source !== null) setText(source);
    });
  }, [props.doc.path, props.doc.modified]);

  useEffect(() => {
    const root = container.current;

    if (root === null || content === null) return;

    /** The block holding a commented passage carries a fillet in the sheet's margin. */
    const fillet = (passages: readonly Passage[]): void => {
      const blocks = [...root.querySelectorAll<HTMLElement>("[data-lines]")];

      const marked = markedIndices(
        blocks.map((block) => ({
          tag: block.tagName.toLowerCase(),
          lines: block.dataset.lines ?? "",
        })),
        passages.map((passage) => passage.lines),
      );

      blocks.forEach((block, index) => block.classList.toggle("marked", marked.has(index)));
    };

    // A passage the edit removed has no text to find and no block to mark: the card says so.
    const commented = props.annotations.flatMap((annotation) =>
      annotation.anchor.kind === "text"
        ? annotation.anchor.passages.filter((passage) => !passage.removed)
        : [],
    );

    const picked = (draft?.chosen ?? []).map((one) => one.passage);

    paint("vellum-comment", rangesOf(root, commented));
    paint("vellum-draft", rangesOf(root, picked));
    box(
      root,
      "commented",
      commented.filter((passage) => passage.kind === "diagram"),
    );
    box(
      root,
      "picked",
      picked.filter((passage) => passage.kind === "diagram"),
    );
    fillet(commented);

    return () => {
      paint("vellum-comment", []);
      paint("vellum-draft", []);
      box(root, "commented", []);
      box(root, "picked", []);
      fillet([]);
    };
  }, [props.annotations, draft, content]);

  // The card the reviewer is on: its passage stands out, and a click brings it into view.
  const focus = focused.value;
  // A click scrolls once: the effect runs again at each new list of annotations.
  const revealed = useRef<typeof focus>(null);

  useEffect(() => {
    const root = container.current;
    const target = focus === null ? null : props.annotations.find((one) => one.id === focus.id);

    if (root === null || content === null || target === undefined || target === null) return;

    const passages =
      target.anchor.kind === "text" ? target.anchor.passages.filter((one) => !one.removed) : [];

    paint("vellum-focus", rangesOf(root, passages));
    box(root, "focused", passages);
    const [first] = passages;

    if (focus?.reveal === true && revealed.current !== focus && first !== undefined) {
      revealed.current = focus;
      blockOf(root, first)?.scrollIntoView({ block: "center" });
    }

    return () => {
      paint("vellum-focus", []);
      box(root, "focused", []);
    };
  }, [focus, props.annotations, content]);

  const night = dark.value;

  // Back from the editor: the plan scrolls to the block of the line under the caret, once the
  // diagrams and the images above it have their size, since each one drawn moves what follows.
  const isPlan = props.doc.path === planDoc.value?.path;

  useEffect(() => {
    const root = container.current;

    if (root === null) return;

    void drawn(root, night).then(() => {
      const line = resume.peek();

      if (line === null || content === null || !isPlan) return;
      const blocks = [...root.querySelectorAll<HTMLElement>("[data-lines]")];

      const holder = blocks.findLast(
        (block) => linesAt(block)[0] <= line && line <= linesAt(block)[1],
      );

      const next = blocks.find((block) => linesAt(block)[0] >= line);
      resume.value = null;
      (holder ?? next)?.scrollIntoView({ block: "start" });
    });
  }, [content, night]);

  // A position is taken from a rect once: whatever reflows the sheet (the comments panel folding,
  // the window, a diagram drawn late) leaves it pointing at other text, so it is taken again.
  useEffect(() => {
    const root = container.current;

    if (root === null) return;

    const observer = new ResizeObserver(() => {
      setWash(null);
      setDraft((current) => {
        const last = current?.chosen.at(-1);

        // A place is never chosen collapsed: a collapsed one lost its text to a reload of the file.
        return current === null || last === undefined || last.range.collapsed
          ? current
          : draftOf(root, current.chosen, last.range.getBoundingClientRect());
      });
    });

    observer.observe(root);

    return () => observer.disconnect();
  }, [content === null]);

  // Cleared, not only hidden: a switch turned back on would reopen the old composer.
  useEffect(() => {
    if (on) return;
    setDraft(null);
    setWash(null);
  }, [on]);

  // On, every block is a Tab stop; off, none is, and the sheet itself takes a click's focus.
  useEffect(() => {
    const root = container.current;

    if (root === null || content === null) return;

    for (const block of root.querySelectorAll<HTMLElement>(FOCUSABLE_BLOCKS)) {
      if (block.dataset.lines === undefined) continue;

      if (on) {
        block.tabIndex = 0;
        continue;
      }

      // A block that stops being focusable drops the focus to `body`, where `c` flips nothing.
      if (block === document.activeElement) root.focus({ preventScroll: true });
      block.removeAttribute("tabindex");
    }
  }, [on, content]);

  const choose = (root: HTMLElement, one: Chosen, event: Modifiers): void => {
    const adding = (event.ctrlKey || event.metaKey) && draft !== null;
    const [first, ...rest] = adding && draft !== null ? toggled(draft.chosen, one) : [one];
    const last = rest.at(-1) ?? first;

    setDraft(
      first === undefined || last === undefined
        ? null
        : draftOf(root, [first, ...rest], last.range.getBoundingClientRect()),
    );
  };

  const onPointerDown = (): void => {
    swallow.current = false;
    dragging.current = true;
  };

  /** A range the reviewer selected, in the sheet or clamped to it, chosen as a place. */
  const pick = (root: HTMLElement, range: Range, event: Modifiers): void => {
    const passage = passageFromRange(root, range);

    if (passage === null) return;
    document.getSelection()?.removeAllRanges();
    choose(root, { range, passage }, event);
  };

  const onMouseUp = (event: MouseEvent): void => {
    const root = container.current;
    const range = root === null || !commenting.value ? null : dragRange(event);
    dragging.current = false;

    if (root === null || range === null) return;
    swallow.current = true;
    pick(root, range, event);
  };

  const latest = useRef(pick);
  latest.current = pick;

  // A drag released past the sheet, and a selection made with the keyboard, released with Shift:
  // both are heard on the document, since neither ends on the sheet.
  useEffect(() => {
    const root = container.current;

    if (root === null || content === null) return;

    const onDocumentMouseUp = (event: MouseEvent): void => {
      if (!dragging.current) return;
      dragging.current = false;
      const range = commenting.peek() ? dragRange(event) : null;

      // A press whose release never came (a link or an image dragged, a context menu) leaves
      // `dragging` set: a selection made elsewhere later is none of the sheet's.
      if (range === null || !range.intersectsNode(root)) return;
      clampTo(root, range);
      latest.current(root, range, event);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      const range = event.key === "Shift" && commenting.peek() ? selectedRange() : null;

      if (range === null || !root.contains(range.commonAncestorContainer)) return;
      latest.current(root, range, event);
    };

    document.addEventListener("mouseup", onDocumentMouseUp);
    document.addEventListener("keyup", onKeyUp);

    return () => {
      document.removeEventListener("mouseup", onDocumentMouseUp);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [content === null]);

  /** Enter on a focused block picks it whole, Ctrl+Enter adds it, as a click and a Ctrl+click do. */
  const onKeyDown = (event: KeyboardEvent): void => {
    const root = container.current;
    const block = event.target instanceof HTMLElement ? event.target : null;

    if (root === null || !commenting.value || event.key !== "Enter" || block === null) return;

    if (!block.hasAttribute("tabindex") || block.dataset.lines === undefined) return;
    event.preventDefault();
    const target = targetOf(root, block);
    const range = target === null ? null : targetRange(target);
    const passage = target === null || range === null ? null : passageOf(root, target, range);

    if (range === null || passage === null) return;
    choose(root, { range, passage }, event);
  };

  const onPointerMove = (event: PointerEvent): void => {
    const root = container.current;

    const target =
      root !== null && commenting.value && event.buttons === 0 && event.target instanceof Element
        ? targetAt(root, event.target, event.clientX, event.clientY)
        : null;

    if (target?.element === wash?.target.element) return;
    const rect = target === null ? undefined : boxOf(target);
    const at = root === null || rect === undefined ? null : inPane(root, rect);

    setWash(
      target === null || rect === undefined || at === null
        ? null
        : { target, ...at, width: rect.width, height: rect.height },
    );
  };

  const onClickCapture = (event: MouseEvent): void => {
    const root = container.current;

    if (root === null || !commenting.value) return;

    // A removed block's summary keeps its click: `preventDefault` would hold it folded.
    if (event.target instanceof Element && event.target.closest("details.removed") !== null) return;
    event.preventDefault();

    if (swallow.current) {
      swallow.current = false;

      return;
    }

    if (!(event.target instanceof Element)) return;
    const target = targetAt(root, event.target, event.clientX, event.clientY);
    const range = target === null ? null : targetRange(target);
    const passage = target === null || range === null ? null : passageOf(root, target, range);

    if (range === null || passage === null) return;
    choose(root, { range, passage }, event);
  };

  const waiting = waitingText(content !== null, failed);

  if (waiting !== null) return <div class="waiting">{waiting}</div>;
  const adding = holding.value && draft !== null;
  const holder = container.current?.parentElement ?? null;
  const pane = draft === null || holder === null ? null : windowOf(holder);

  const leave = (): void => {
    const root = container.current;
    const first = draft?.chosen[0];
    setDraft(null);

    if (root !== null && first !== undefined) focusPassage(root, first.passage);
  };

  return (
    <>
      <article
        {...{ [SHEET_ATTRIBUTE]: "" }}
        class={adding ? "plan adding" : "plan"}
        ref={container}
        tabIndex={-1}
        onMouseUp={onMouseUp}
        onClick={onClick}
        onClickCapture={onClickCapture}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setWash(null)}
      >
        {content}
      </article>
      {wash !== null && (
        <div
          class="wash"
          style={{
            top: `${wash.top}px`,
            left: `${wash.left}px`,
            width: `${wash.width}px`,
            height: `${wash.height}px`,
          }}
        >
          <span class="wash-label">{wash.target.label}</span>
        </div>
      )}
      {draft !== null && pane !== null && (
        <Composer
          doc={props.doc.path}
          picks={draft.chosen.map(({ passage }) => ({
            key: `${passage.lines[0]}-${passage.prefix}-${passage.quote}`,
            passage,
          }))}
          through={adding}
          target={draft.target}
          pane={pane}
          onCancel={leave}
          onSubmit={(mark) => {
            const [first, ...rest] = draft.chosen;
            const passages = [first.passage, ...rest.map((one) => one.passage)] as const;
            props.annotate({ doc: props.doc.path, anchor: { kind: "text", passages }, mark });
            leave();
          }}
        />
      )}
    </>
  );
}

export const markdownPage: PageExtension = {
  id: "markdown",
  renderers: [{ accepts: (doc) => doc.mediaType === "text/markdown", component: MarkdownDoc }],
};
