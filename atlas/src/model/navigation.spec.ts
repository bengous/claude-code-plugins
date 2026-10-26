import { describe, expect, test } from "bun:test";

import SAMPLE from "../../fixtures/sample/map.ts";
import { DEEP, randomMap } from "../../fixtures/trees.ts";
import type { Journey, Node } from "./atlas.ts";
import type { Params, Place, PlaceEvent, Scope, Shown } from "./navigation.ts";
import {
  DEFAULTS,
  HOME,
  crumbsOf,
  foldedCrumbs,
  hashOf,
  navigate,
  normalised,
  openOf,
  pageStateOf,
  paramsAfter,
  paramsOfHash,
  placeOfHash,
  shownPlace,
  stepShown,
} from "./navigation.ts";
import type { Tree } from "./tree.ts";
import { chainOf, treeOf } from "./tree.ts";
import { viewOf } from "./view.ts";

const sample = treeOf(SAMPLE);

const deep = treeOf(DEEP);

const PHASES = ["v1", "v2"];

const onSample: Scope = { tree: sample, phases: PHASES };

const unphased = (tree: Tree): Scope => ({ tree, phases: [] });

const onDeep = unphased(deep);

const run = (tree: Tree, place: Place, events: readonly PlaceEvent[]): Place =>
  events.reduce((at, event) => navigate(tree, at, event), place);

const at = (path: readonly string[], selected: string | null = null): Place => ({ path, selected });

const card = (id: string): Node => ({ id, label: id, sub: "", color: "c" });

describe("enter", () => {
  test("a container child opens its view, one level at a time, clearing the selection", () => {
    const app = run(sample, HOME, [
      { type: "enter", id: "server" },
      { type: "select", id: "proxy" },
      { type: "enter", id: "app" },
    ]);

    expect(app).toEqual(at(["server", "app"]));
  });

  test("a leaf, a container deeper down, or a ghost leaves the place as it is", () => {
    const server = at(["server"]);

    for (const id of ["proxy", "web", "clients", "nowhere"]) {
      expect(navigate(sample, server, { type: "enter", id })).toBe(server);
    }

    expect(navigate(sample, HOME, { type: "enter", id: "app" })).toBe(HOME);
  });
});

describe("select", () => {
  test("a box of the open view is selected where it stands", () => {
    expect(navigate(sample, at(["server", "app"]), { type: "select", id: "orders" })).toEqual(
      at(["server", "app"], "orders"),
    );

    expect(navigate(sample, at(["server"]), { type: "select", id: "data" })).toEqual(
      at(["server"], "data"),
    );
  });

  test("a ghost is selected in place: the reader keeps the view the link was read from", () => {
    expect(navigate(sample, at(["server", "app"]), { type: "select", id: "email" })).toEqual(
      at(["server", "app"], "email"),
    );

    expect(navigate(deep, at(["A", "A1", "A11", "A111"]), { type: "select", id: "B" })).toEqual(
      at(["A", "A1", "A11", "A111"], "B"),
    );
  });

  test("a chip, a node the view does not show, or an unknown id leaves the place as it is", () => {
    const server = at(["server"], "proxy");

    for (const id of ["web", "db", "browser", "nowhere"]) {
      expect(navigate(sample, server, { type: "select", id })).toBe(server);
    }
  });
});

describe("up, home and escape", () => {
  test("up opens the parent's view and clears the selection; the root stays put", () => {
    expect(navigate(deep, at(["A", "A1", "A11"], "a3"), { type: "up" })).toEqual(at(["A", "A1"]));

    const root = at([], "X");

    expect(navigate(deep, root, { type: "up" })).toBe(root);
  });

  test("home opens the root's view from anywhere", () => {
    expect(navigate(deep, at(["B", "B1", "B11", "B111"], "b2"), { type: "home" })).toBe(HOME);
  });

  test("escape deselects first, then climbs one level per press, then rests at the root", () => {
    const steps = [at(["A", "A1", "A11", "A111"], "a1")];

    for (let i = 0; i < 6; i += 1) {
      const last = steps.at(-1) ?? HOME;
      steps.push(navigate(deep, last, { type: "escape" }));
    }

    expect(steps).toEqual([
      at(["A", "A1", "A11", "A111"], "a1"),
      at(["A", "A1", "A11", "A111"]),
      at(["A", "A1", "A11"]),
      at(["A", "A1"]),
      at(["A"]),
      HOME,
      HOME,
    ]);
  });

  test("escape at the root deselects", () => {
    expect(navigate(sample, at([], "email"), { type: "escape" })).toEqual(HOME);
  });
});

describe("jump", () => {
  test("a container opens its own view", () => {
    expect(navigate(sample, at(["server", "app"], "web"), { type: "jump", id: "data" })).toEqual(
      at(["server", "data"]),
    );

    expect(navigate(deep, HOME, { type: "jump", id: "B111" })).toEqual(
      at(["B", "B1", "B11", "B111"]),
    );

    expect(navigate(sample, HOME, { type: "jump", id: "clients" })).toEqual(at(["clients"]));
  });

  test("a leaf opens its parent's view with the leaf selected, at any depth", () => {
    expect(navigate(deep, HOME, { type: "jump", id: "a1" })).toEqual(
      at(["A", "A1", "A11", "A111"], "a1"),
    );

    expect(navigate(sample, at(["server"]), { type: "jump", id: "browser" })).toEqual(
      at(["clients"], "browser"),
    );
  });

  test("a leaf child of the root selects it on the root's view", () => {
    expect(navigate(sample, at(["server", "app"]), { type: "jump", id: "email" })).toEqual(
      at([], "email"),
    );
  });

  test("an unknown id, or none, opens the root's view", () => {
    expect(navigate(deep, at(["A"], "A1"), { type: "jump", id: "nowhere" })).toBe(HOME);
    expect(navigate(deep, at(["A"], "A1"), { type: "jump", id: "" })).toBe(HOME);
  });
});

describe("a place the tree cannot show", () => {
  test("a stale path is cut where it breaks, and a selection that view does not show dropped", () => {
    expect(normalised(sample, at(["server", "gone"], "x"))).toEqual(at(["server"]));
    expect(normalised(sample, at(["server", "app", "web"]))).toEqual(at(["server", "app"]));
  });

  test("a path that is not a chain from the root keeps only its valid start", () => {
    expect(normalised(sample, at(["app"], "web"))).toEqual(HOME);
    expect(normalised(sample, at(["server", "clients"]))).toEqual(at(["server"]));
  });

  test("a place the tree shows comes back as it is", () => {
    const place = at(["server", "app"], "email");

    expect(normalised(sample, place)).toBe(place);
  });

  test("navigate, crumbsOf and hashOf read a stale place as normalised instead of throwing", () => {
    const stale = at(["server", "gone"], "x");

    expect(navigate(sample, stale, { type: "select", id: "proxy" })).toEqual(
      at(["server"], "proxy"),
    );

    expect(navigate(sample, stale, { type: "up" })).toEqual(HOME);
    expect(crumbsOf(sample, stale)).toHaveLength(2);
    expect(hashOf(onSample, stale)).toBe("server");
  });
});

describe("crumbsOf", () => {
  test("the root, the path, then the selected box marked selected", () => {
    expect(crumbsOf(sample, at(["server", "app"], "orders"))).toEqual([
      { kind: "root" },
      { kind: "node", id: "server", label: "Server", selected: false },
      { kind: "node", id: "app", label: "Application", selected: false },
      { kind: "node", id: "orders", label: "Orders", selected: true },
    ]);
  });

  test("a selected ghost ends the breadcrumb, marked selected", () => {
    expect(crumbsOf(sample, at(["server", "app"], "email")).at(-1)).toEqual({
      kind: "node",
      id: "email",
      label: "Email service",
      selected: true,
    });
  });

  test("a selected container and the same container opened differ", () => {
    const selected = crumbsOf(deep, at(["A"], "A1"));
    const opened = crumbsOf(deep, at(["A", "A1"]));

    expect(selected.map((c) => (c.kind === "root" ? "root" : `${c.id} ${c.selected}`))).toEqual([
      "root",
      "A false",
      "A1 true",
    ]);

    expect(opened.map((c) => (c.kind === "root" ? "root" : `${c.id} ${c.selected}`))).toEqual([
      "root",
      "A false",
      "A1 false",
    ]);
  });

  test("the root's view alone is the root crumb", () => {
    expect(crumbsOf(sample, HOME)).toEqual([{ kind: "root" }]);
  });
});

const ids = (shown: readonly Shown[]): string[] =>
  shown.map((c) =>
    c.kind === "root"
      ? "root"
      : c.kind === "fold"
        ? `[${c.crumbs.map((f) => (f.kind === "root" ? "root" : f.id)).join(" ")}]`
        : c.id,
  );

describe("foldedCrumbs", () => {
  test("five crumbs or more fold the levels between the root and the last two", () => {
    expect(ids(foldedCrumbs(crumbsOf(deep, at(["B", "B1", "B11", "B111"], "b1"))))).toEqual([
      "root",
      "[B B1 B11]",
      "B111",
      "b1",
    ]);

    expect(ids(foldedCrumbs(crumbsOf(deep, at(["B", "B1", "B11", "B111"]))))).toEqual([
      "root",
      "[B B1]",
      "B11",
      "B111",
    ]);
  });

  test("four crumbs or fewer stay as they are", () => {
    const four = crumbsOf(sample, at(["server", "app"], "orders"));

    expect(foldedCrumbs(four)).toEqual(four);
    expect(foldedCrumbs(crumbsOf(sample, HOME))).toEqual([{ kind: "root" }]);
  });
});

describe("hashOf and placeOfHash", () => {
  test("a place a jump lands on keeps its bare #id", () => {
    expect(hashOf(onSample, HOME)).toBe("");
    expect(hashOf(onSample, at(["server", "app"]))).toBe("app");
    expect(hashOf(onSample, at(["server", "app"], "orders"))).toBe("orders");
    expect(hashOf(onSample, at([], "email"))).toBe("email");
  });

  test("a selected ghost or container carries the open view and the selection", () => {
    expect(hashOf(onSample, at(["server", "app"], "email"))).toBe("app/email");
    expect(hashOf(onDeep, at(["A"], "A1"))).toBe("A/A1");
    expect(hashOf(onSample, at([], "server"))).toBe("/server");
  });

  test("each id is percent-encoded, so a slash in an id cannot split it", () => {
    const tree = treeOf({
      root: {
        title: "T",
        children: [
          { id: "a/b", label: "x", sub: "", color: "c", children: [card("c d")] },
          { id: "e", label: "e", sub: "", color: "c", children: [card("f")] },
        ],
      },
      links: [{ from: "c d", to: "f", label: "l" }],
    });

    const place = at(["a/b"], "e");

    expect(hashOf(unphased(tree), place)).toBe("a%2Fb/e");
    expect(placeOfHash(tree, hashOf(unphased(tree), place))).toEqual(place);
    expect(placeOfHash(tree, "#c%20d")).toEqual(at(["a/b"], "c d"));
  });

  test("a bare #id reads as a jump", () => {
    expect(placeOfHash(deep, "#a1")).toEqual(at(["A", "A1", "A11", "A111"], "a1"));
    expect(placeOfHash(deep, "B111")).toEqual(at(["B", "B1", "B11", "B111"]));
    expect(placeOfHash(deep, "")).toBe(HOME);
  });

  test("a fragment that names nothing, or does not decode, opens the root's view", () => {
    for (const hash of ["#nowhere", "#nowhere/a1", "#a1/a2", "#%E0%A4%A", "#A/%E0%A4%A"]) {
      expect(placeOfHash(deep, hash)).toBe(HOME);
    }
  });

  test("a selection the open view does not show is dropped", () => {
    expect(placeOfHash(deep, "#A1/b1")).toEqual(at(["A", "A1"]));
  });
});

const CARDS: Params = { ...DEFAULTS, mode: "cards" };

const V1: Params = { ...DEFAULTS, phase: "v1" };

const V2: Params = { ...DEFAULTS, phase: "v2" };

const CARDS_V2: Params = { ...DEFAULTS, mode: "cards", phase: "v2" };

const withLeaf = (id: string, leaf: string): Node => ({
  id,
  label: id,
  sub: "",
  color: "c",
  children: [{ ...card(leaf), io: [["Receives", "x"]] }, card(`${leaf} 2`)],
});

const ROOT_CARDS = treeOf({
  root: { title: "T", children: [{ ...card("p"), io: [["Receives", "x"]] }, card("q")] },
  links: [],
});

const onRootCards = unphased(ROOT_CARDS);

describe("the fragment's parameters", () => {
  test("every fragment form the specs above cover is written and read as before", () => {
    const forms: [Scope, Place, string][] = [
      [onSample, HOME, ""],
      [onSample, at(["server", "app"]), "app"],
      [onSample, at(["server", "app"], "orders"), "orders"],
      [onSample, at([], "email"), "email"],
      [onSample, at(["server", "app"], "email"), "app/email"],
      [onSample, at(["server"], "email"), "server/email"],
      [onSample, at([], "server"), "/server"],
      [onDeep, at(["A"], "A1"), "A/A1"],
      [onDeep, at(["A", "A1", "A11", "A111"], "a1"), "a1"],
    ];

    for (const [scope, place, hash] of forms) {
      expect(hashOf(scope, place, DEFAULTS)).toBe(hash);
      expect(placeOfHash(scope.tree, `#${hash}`)).toEqual(place);
      expect(paramsOfHash(scope, `#${hash}`)).toEqual(DEFAULTS);
    }
  });

  test("the mode round-trips through the fragment, after the place", () => {
    expect(hashOf(onRootCards, HOME, CARDS)).toBe("?mode=cards");
    expect(hashOf(onSample, at(["server", "app"]), CARDS)).toBe("app?mode=cards");
    expect(hashOf(onSample, at(["server", "app"], "email"), CARDS)).toBe("app/email?mode=cards");

    for (const [scope, place] of [
      [onRootCards, HOME],
      [onRootCards, at([], "q")],
      [onSample, at(["server", "app"])],
      [onSample, at(["server", "app"], "orders")],
      [onSample, at(["server", "app"], "email")],
    ] as const) {
      const hash = `#${hashOf(scope, place, CARDS)}`;

      expect(placeOfHash(scope.tree, hash)).toEqual(place);
      expect(paramsOfHash(scope, hash)).toEqual(CARDS);
    }
  });

  test("the phase round-trips through the fragment, after the mode", () => {
    expect(hashOf(onSample, HOME, V1)).toBe("?phase=v1");
    expect(hashOf(onSample, at(["server", "app"]), V1)).toBe("app?phase=v1");
    expect(hashOf(onSample, at(["server", "app"], "email"), CARDS_V2)).toBe(
      "app/email?mode=cards&phase=v2",
    );

    for (const [place, params] of [
      [HOME, V1],
      [at([], "email"), V2],
      [at(["server", "data"], "db"), V1],
      [at(["server"], "email"), V2],
      [at(["server", "app"], "orders"), CARDS_V2],
      [at(["server", "app"], "email"), CARDS_V2],
    ] as const) {
      const hash = `#${hashOf(onSample, place, params)}`;

      expect(placeOfHash(sample, hash)).toEqual(place);
      expect(paramsOfHash(onSample, hash)).toEqual(params);
    }
  });

  test("a phase's name is percent-encoded, so a separator in it cannot cut the fragment", () => {
    const odd = "Phase 2 & co?=/";
    const scope: Scope = { tree: sample, phases: [odd] };
    const params: Params = { ...DEFAULTS, phase: odd };
    const hash = hashOf(scope, at(["server", "app"], "email"), params);

    expect(hash).toBe("app/email?phase=Phase%202%20%26%20co%3F%3D%2F");
    expect(placeOfHash(sample, hash)).toEqual(at(["server", "app"], "email"));
    expect(paramsOfHash(scope, hash)).toEqual(params);
  });

  test("a phase the Config does not list goes back to every phase, written, read or moved to", () => {
    const app = at(["server", "app"]);
    const v3: Params = { ...DEFAULTS, mode: "cards", phase: "v3" };

    expect(hashOf(onSample, app, v3)).toBe("app?mode=cards");
    expect(paramsOfHash(onSample, "#app?phase=v3")).toEqual(DEFAULTS);
    expect(paramsOfHash(onSample, "#app?phase=V1")).toEqual(DEFAULTS);
    expect(pageStateOf(onSample, app, v3).phase).toBeNull();
    expect(paramsAfter(onSample, app, at(["server", "app"], "orders"), v3)).toEqual(CARDS);
    expect(hashOf(unphased(sample), app, V1)).toBe("app");
    expect(paramsOfHash(unphased(sample), "#app?phase=v1")).toEqual(DEFAULTS);
  });

  test("an id holding a separator's character round-trips, with its mode", () => {
    const separated = ["a?b", "c&d", "e=f", "g/h", "i;j"];

    const tree = treeOf({
      root: {
        title: "T",
        children: [
          ...separated.map((id) => withLeaf(id, `${id} leaf?mode=map&mode=map`)),
          { ...card("k?mode=map"), io: [["Receives", "x"]] },
          card("l&mode=map"),
        ],
      },
      links: [{ from: "a?b leaf?mode=map&mode=map", to: "c&d leaf?mode=map&mode=map", label: "l" }],
    });

    const places = [
      ...separated.flatMap((id) => [at([id]), at([id], `${id} leaf?mode=map&mode=map`)]),
      at(["a?b"], "c&d"),
      at([], "a?b"),
      at([], "k?mode=map"),
    ];

    const scope: Scope = { tree, phases: PHASES };

    expect(hashOf(scope, at(["a?b"], "c&d"), CARDS)).toBe("a%3Fb/c%26d?mode=cards");

    for (const place of places) {
      for (const params of [DEFAULTS, CARDS, V1, CARDS_V2]) {
        const hash = `#${hashOf(scope, place, params)}`;

        expect(placeOfHash(tree, hash)).toEqual(place);
        expect(paramsOfHash(scope, hash)).toEqual(params);
      }
    }
  });

  test("a malformed or unknown parameter is dropped, the view and the selection kept", () => {
    const place = at(["server", "app"], "email");

    for (const params of [
      "mode=bogus",
      "mode",
      "mode=",
      "=cards",
      "nope=cards",
      "MODE=cards",
      "mode=cards=x",
      "mode=%E0%A4%A",
      "phase=",
      "phase",
      "PHASE=v1",
      "phase=%E0%A4%A",
      "phase=v3",
      "journey=",
      "journey",
      "JOURNEY=checkout",
      "journey=checkout",
      "journey=%E0%A4%A",
      "step=2",
      "",
      "&&",
    ]) {
      const hash = `#app/email?${params}`;

      expect(placeOfHash(sample, hash)).toEqual(place);
      expect(paramsOfHash(onSample, hash)).toEqual(DEFAULTS);
    }
  });

  test("a parameter dropped leaves the others read; of a key given twice, the first read counts", () => {
    expect(paramsOfHash(onSample, "#orders?nope=1&mode&mode=cards")).toEqual(CARDS);
    expect(paramsOfHash(onSample, "#orders?mode=cards&mode=map")).toEqual(CARDS);
    expect(paramsOfHash(onSample, "#orders?mode=bogus&mode=cards")).toEqual(CARDS);
    expect(paramsOfHash(onSample, "#orders?mode=map&mode=cards")).toEqual(DEFAULTS);
    expect(paramsOfHash(onSample, "#orders?phase=&phase=v2")).toEqual(V2);
    expect(paramsOfHash(onSample, "#orders?phase=v2&phase=v1")).toEqual(V2);
    expect(paramsOfHash(onSample, "#orders?phase=v2&mode=bogus&mode=cards")).toEqual(CARDS_V2);
    expect(placeOfHash(sample, "#orders?nope=1&mode=cards")).toEqual(
      at(["server", "app"], "orders"),
    );
  });

  test("the cards on a container that has none go back to the map, written, read or moved to", () => {
    const data = at(["server", "data"], "db");

    expect(hashOf(onSample, data, CARDS)).toBe("db");
    expect(paramsOfHash(onSample, "#db?mode=cards")).toEqual(DEFAULTS);
    expect(placeOfHash(sample, "#db?mode=cards")).toEqual(data);
    expect(pageStateOf(onSample, data, CARDS).mode).toBe("map");
    expect(paramsAfter(onSample, data, at(["server", "data"]), CARDS)).toEqual(DEFAULTS);
    expect(hashOf(onDeep, at(["A", "A1"]), CARDS)).toBe("A1");
    expect(hashOf(onSample, HOME, CARDS)).toBe("");
    expect(paramsOfHash(onSample, "#?mode=cards")).toEqual(DEFAULTS);
    expect(hashOf(onSample, data, CARDS_V2)).toBe("db?phase=v2");
  });
});

const after = (from: Place, event: PlaceEvent, params: Params = CARDS): Params =>
  paramsAfter(onSample, from, navigate(sample, from, event), params);

describe("paramsAfter", () => {
  test("opening another container resets the mode", () => {
    const orders = at(["server", "app"], "orders");

    for (const event of [
      { type: "up" },
      { type: "home" },
      { type: "jump", id: "data" },
      { type: "jump", id: "browser" },
    ] as const) {
      expect(after(orders, event)).toEqual(DEFAULTS);
    }

    expect(after(at(["server"]), { type: "enter", id: "app" })).toEqual(DEFAULTS);
    expect(after(at(["server", "app"]), { type: "escape" })).toEqual(DEFAULTS);
  });

  test("a move within the open container keeps the mode", () => {
    const orders = at(["server", "app"], "orders");

    for (const event of [
      { type: "select", id: "catalog" },
      { type: "select", id: "email" },
      { type: "escape" },
      { type: "jump", id: "web" },
      { type: "jump", id: "app" },
      { type: "enter", id: "nowhere" },
    ] as const) {
      expect(after(orders, event)).toEqual(CARDS);
    }
  });

  test("the phase stays across moves, opening another container among them", () => {
    const orders = at(["server", "app"], "orders");

    for (const event of [
      { type: "up" },
      { type: "home" },
      { type: "jump", id: "data" },
      { type: "jump", id: "browser" },
      { type: "select", id: "catalog" },
      { type: "escape" },
    ] as const) {
      expect(after(orders, event, CARDS_V2).phase).toBe("v2");
      expect(after(orders, event, V1)).toEqual(V1);
    }

    expect(after(at(["server"]), { type: "enter", id: "app" }, CARDS_V2)).toEqual(V2);
    expect(after(at(["server", "app"]), { type: "escape" }, CARDS_V2)).toEqual(V2);
  });
});

const CHECKOUT: Journey = {
  id: "checkout",
  label: "Checkout",
  steps: [
    { from: "browser", to: "proxy" },
    { from: "proxy", to: "web" },
    { from: "web", to: "orders" },
    { from: "orders", to: "db" },
  ],
};

const journeyed = treeOf({
  ...SAMPLE,
  root: {
    ...SAMPLE.root,
    journeys: [CHECKOUT, { id: "empty", label: "Empty", steps: [] }],
  },
});

const onJourneys: Scope = { tree: journeyed, phases: PHASES };

const playing = (step: number, params: Params = DEFAULTS): Params => ({
  ...params,
  journey: "checkout",
  step,
});

describe("a journey", () => {
  test("the journey and its step round-trip through the fragment, after the phase", () => {
    expect(hashOf(onJourneys, HOME, playing(1))).toBe("?journey=checkout");
    expect(hashOf(onJourneys, at(["server", "app"]), playing(3))).toBe(
      "app?journey=checkout&step=3",
    );
    expect(hashOf(onJourneys, at(["server", "app"], "email"), playing(4, V2))).toBe(
      "app/email?phase=v2&journey=checkout&step=4",
    );

    for (const place of [
      HOME,
      at([], "email"),
      at(["server", "app"]),
      at(["server", "app"], "orders"),
      at(["server", "app"], "email"),
      at(["server"], "app"),
    ]) {
      for (const params of [playing(1), playing(2), playing(4, V1), playing(3, V2)]) {
        const hash = `#${hashOf(onJourneys, place, params)}`;

        expect(placeOfHash(journeyed, hash)).toEqual(place);
        expect(paramsOfHash(onJourneys, hash)).toEqual(params);
      }
    }
  });

  test("a journey's id is percent-encoded, so a separator in it cannot cut the fragment", () => {
    const odd = "a&b?c=d/e";

    const tree = treeOf({
      ...SAMPLE,
      root: { ...SAMPLE.root, journeys: [{ ...CHECKOUT, id: odd }] },
    });

    const scope: Scope = { tree, phases: PHASES };
    const params: Params = { ...DEFAULTS, journey: odd, step: 2 };
    const hash = hashOf(scope, at(["server", "app"], "email"), params);

    expect(hash).toBe("app/email?journey=a%26b%3Fc%3Dd%2Fe&step=2");
    expect(placeOfHash(tree, hash)).toEqual(at(["server", "app"], "email"));
    expect(paramsOfHash(scope, hash)).toEqual(params);
  });

  test("on a journey, the place stays where it started and the view shown is its step's", () => {
    const start = at(["server", "app"], "orders");

    expect(shownPlace(onJourneys, start, DEFAULTS)).toBe(start);
    expect(shownPlace(onJourneys, start, playing(1))).toEqual(HOME);
    expect(shownPlace(onJourneys, start, playing(2))).toEqual(at(["server", "app"]));
    expect(shownPlace(onJourneys, start, playing(3))).toEqual(at(["server", "app"]));
    expect(shownPlace(onJourneys, start, playing(4))).toEqual(at(["server"]));
    expect(shownPlace(onSample, start, playing(2))).toBe(start);
  });

  test("the step shown, the first for a step past the last; none off a journey", () => {
    expect(stepShown(onJourneys, playing(2))).toEqual({ from: "proxy", to: "web" });
    expect(stepShown(onJourneys, playing(9))).toEqual({ from: "browser", to: "proxy" });
    expect(stepShown(onJourneys, DEFAULTS)).toBeNull();
    expect(stepShown(onJourneys, { ...DEFAULTS, journey: "empty" })).toBeNull();
    expect(stepShown(onSample, playing(2))).toBeNull();
  });

  test("the page's state shows the step's view, the fragment the place it started from", () => {
    const state = pageStateOf(onJourneys, at(["server", "app"], "orders"), playing(4, V1));

    expect(state).toEqual({
      mode: "map",
      phase: "v1",
      journey: "checkout",
      step: 4,
      path: ["server"],
      selected: null,
      visible: [
        "proxy",
        "app",
        "web",
        "catalog",
        "orders",
        "data",
        "db",
        "backup",
        "clients",
        "email",
      ],
      fragment: "orders?phase=v1&journey=checkout&step=4",
    });
  });

  test("the cards cannot show a journey's arrow: on a journey, the mode goes back to the map", () => {
    const cards = playing(2, CARDS);

    expect(hashOf(onJourneys, at(["server", "app"]), cards)).toBe("app?journey=checkout&step=2");
    expect(paramsOfHash(onJourneys, "#app?mode=cards&journey=checkout&step=2")).toEqual(playing(2));
    expect(pageStateOf(onJourneys, at(["server", "app"]), cards).mode).toBe("map");
  });

  test("a journey the root does not declare or without a step, and a step past the last or without a journey, go back to their defaults", () => {
    const app = at(["server", "app"]);

    for (const hash of ["#app?journey=nowhere&step=2", "#app?journey=empty", "#app?step=2"]) {
      expect(paramsOfHash(onJourneys, hash)).toEqual(DEFAULTS);
      expect(placeOfHash(journeyed, hash)).toEqual(app);
    }

    for (const step of ["5", "0", "-1", "1.5", "02", "x", "", "99999999999999999999"]) {
      expect(paramsOfHash(onJourneys, `#app?journey=checkout&step=${step}`)).toEqual(playing(1));
    }

    expect(hashOf(onJourneys, app, { ...DEFAULTS, step: 3 })).toBe("app");
    expect(hashOf(onJourneys, app, playing(9))).toBe("app?journey=checkout");
    expect(hashOf(onJourneys, app, { ...DEFAULTS, journey: "nowhere" })).toBe("app");
    expect(hashOf(onSample, app, playing(2))).toBe("app");
    expect(paramsOfHash(onSample, "#app?journey=checkout&step=2")).toEqual(DEFAULTS);
  });

  test("a move, made from the step's view, leaves the journey and keeps the phase", () => {
    const start = at(["server", "app"], "orders");
    const params = playing(2, V1);
    const from = shownPlace(onJourneys, start, params);

    for (const event of [
      { type: "select", id: "catalog" },
      { type: "select", id: "proxy" },
      { type: "escape" },
      { type: "up" },
      { type: "home" },
      { type: "jump", id: "db" },
      { type: "enter", id: "nowhere" },
    ] as const) {
      const to = navigate(journeyed, from, event);

      expect(paramsAfter(onJourneys, from, to, params)).toEqual(V1);
    }

    expect(navigate(journeyed, from, { type: "select", id: "catalog" })).toEqual(
      at(["server", "app"], "catalog"),
    );
  });
});

describe("pageStateOf", () => {
  test("the root's view: no path, its children as boxes and chips, its outside nodes", () => {
    expect(pageStateOf(onSample, HOME)).toEqual({
      mode: "map",
      phase: null,
      journey: null,
      step: 1,
      path: [],
      selected: null,
      visible: ["clients", "browser", "server", "proxy", "app", "data", "email"],
      fragment: "",
    });
  });

  test("a deeper view: its path, the selection, its boxes then its ghosts, the fragment", () => {
    expect(pageStateOf(onSample, at(["server", "app"], "orders"))).toEqual({
      mode: "map",
      phase: null,
      journey: null,
      step: 1,
      path: ["server", "app"],
      selected: "orders",
      visible: ["web", "catalog", "orders", "proxy", "data", "email"],
      fragment: "orders",
    });
    expect(pageStateOf(onSample, at(["server"], "email")).fragment).toBe("server/email");
  });

  test("each parameter of the fragment shows as its own field", () => {
    const state = pageStateOf(onSample, at(["server", "app"], "orders"), CARDS_V2);

    expect(state.mode).toBe("cards");
    expect(state.phase).toBe("v2");
    expect(state.fragment).toBe("orders?mode=cards&phase=v2");
  });

  test("a stale place reads as the tree shows it, and the state is frozen", () => {
    const state = pageStateOf(onSample, at(["server", "nowhere"], "orders"));

    expect(state.path).toEqual(["server"]);
    expect(state.selected).toBeNull();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.visible)).toBe(true);
    expect(Object.isFrozen(state.path)).toBe(true);
  });
});

describe("a walk through every map", () => {
  test("the deep map's leaves are reached by entering one container per level", () => {
    const place = run(deep, HOME, [
      { type: "enter", id: "B" },
      { type: "enter", id: "B1" },
      { type: "enter", id: "B11" },
      { type: "enter", id: "B111" },
      { type: "select", id: "b1" },
    ]);

    expect(place).toEqual(navigate(deep, HOME, { type: "jump", id: "b1" }));

    expect(crumbsOf(deep, place).map((c) => (c.kind === "root" ? "root" : c.id))).toEqual([
      "root",
      "B",
      "B1",
      "B11",
      "B111",
      "b1",
    ]);
  });

  test.each([
    ["the sample", sample],
    ["the deep map", deep],
    ...[1, 2, 3, 5, 8, 13].map((seed): [string, Tree] => [
      `random map ${seed}`,
      treeOf(randomMap(seed)),
    ]),
  ])("%s: a jump to any node shows it, and escape leads home in one press per level", (_, tree) => {
    for (const [id, node] of tree.nodes) {
      const place = navigate(tree, HOME, { type: "jump", id });
      const view = viewOf(tree, openOf(place));
      const chain = chainOf(tree, id);

      if (node.children === undefined) {
        expect(place).toEqual(at(chain.slice(0, -1), id));
        expect(view.boxes.some((b) => b.id === id)).toBe(true);
      } else {
        expect(place).toEqual(at(chain));
      }

      const presses = place.path.length + (place.selected === null ? 0 : 1);
      const escapes = Array.from({ length: presses }, (): PlaceEvent => ({ type: "escape" }));

      expect(run(tree, place, escapes)).toEqual(HOME);
      expect(run(tree, place, escapes.slice(1))).not.toEqual(HOME);

      for (const item of [...view.boxes, ...view.ghosts]) {
        expect(navigate(tree, place, { type: "select", id: item.id }).selected).toBe(item.id);
      }
    }
  });

  test.each([
    ["the sample", sample],
    ["the deep map", deep],
    ...[1, 2, 3, 5, 8, 13].map((seed): [string, Tree] => [
      `random map ${seed}`,
      treeOf(randomMap(seed)),
    ]),
  ])("%s: every place survives its hash, and no two share a breadcrumb", (_, tree) => {
    const containers = [
      null,
      ...[...tree.nodes.values()].flatMap((n) => (n.children === undefined ? [] : [n.id])),
    ];

    const places = containers.flatMap((container) => {
      const view = viewOf(tree, container);
      const path = container === null ? [] : chainOf(tree, container);

      return [null, ...view.boxes, ...view.ghosts].map((item) => at(path, item?.id ?? null));
    });

    const scope: Scope = { tree, phases: PHASES };

    for (const place of places) {
      const hash = `#${hashOf(scope, place)}`;
      const phased = `#${hashOf(scope, place, V1)}`;

      expect(placeOfHash(tree, hash)).toEqual(place);
      expect(hash).not.toContain("?");
      expect(paramsOfHash(scope, hash)).toEqual(DEFAULTS);
      expect(phased).toBe(`${hash}?phase=v1`);
      expect(placeOfHash(tree, phased)).toEqual(place);
      expect(paramsOfHash(scope, phased)).toEqual(V1);
    }

    const crumbs = new Set(places.map((place) => JSON.stringify(crumbsOf(tree, place))));

    expect(crumbs.size).toBe(places.length);
  });
});
