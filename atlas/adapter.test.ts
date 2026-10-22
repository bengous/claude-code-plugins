import { describe, expect, test } from "bun:test";

import { toPlan } from "./adapter.ts";
import type { AtlasMap, Config, Link, Node } from "./atlas.ts";
import config from "./fixtures/sample/atlas.config.ts";
import map from "./fixtures/sample/map.ts";
import type { Plan } from "./model.ts";

const SAMPLE: Plan = {
  overview: {
    kicker: "a sample map",
    title: "Bookshop",
    lead: "A small online bookshop: readers browse the catalog and order books from their browser; one server runs the application behind a reverse proxy and keeps the data in PostgreSQL; an outside service sends the order mails.",
    why: [
      "One process serves the pages and the orders: the shop is small enough that a second service would cost more than it saves.",
      "The database is the only state: the application keeps nothing on its own disk.",
    ],
    facts: [
      ["Code", "TypeScript on Bun"],
      ["Data", "PostgreSQL"],
      ["Mail", "an outside email service"],
    ],
    how: "The overview shows the server with its application and its storage, the clients on the left and the email service on the right. A click on a zone or a brick opens the detail: every brick and every arrow, and on the arrow into the email service the tags it carries.",
    seams: [
      [
        "catalog",
        "A new way to browse = a query in <code>catalog</code> and its route in <code>web</code>.",
      ],
    ],
    traps: [
      [
        "orders",
        "An order is written and its mail sent in one request: a slow email service slows the checkout.",
      ],
    ],
    src: "a sample written for the atlas plugin",
  },
  zones: [
    {
      id: "clients",
      ext: true,
      side: "in",
      color: "--z-olive",
      title: "Clients",
      tag: "outside the server",
      kw: ["the reader's browser", "HTTPS only", "no account needed to browse"],
      info: {
        title: "Clients",
        lead: "Where readers come from: a browser on a computer or a phone.",
        see: ["browser"],
      },
    },
    {
      id: "server",
      color: "--z-brown",
      title: "Server",
      tag: "one virtual machine",
      kw: ["reverse proxy in front", "one application process", "one database"],
      info: {
        kicker: "deploy/",
        title: "Server",
        lead: "One virtual machine runs the reverse proxy, the application and the database. Only the proxy listens on the network.",
        facts: [["Ports", "443 only"]],
        see: ["proxy", "app", "data"],
        src: "deploy/compose.yml",
      },
    },
    {
      id: "app",
      parent: "server",
      color: "--z-blue",
      title: "Application",
      tag: "Bun process",
      kw: ["pages and routes", "catalog", "orders"],
      info: {
        kicker: "src/",
        title: "Application",
        lead: "One Bun process serves the pages, answers the catalog queries and takes the orders.",
        see: ["web", "catalog", "orders"],
        src: "src/",
      },
    },
    {
      id: "data",
      parent: "server",
      color: "--z-indigo",
      title: "Storage",
      tag: "PostgreSQL",
      kw: ["books and orders", "one database", "a dump each night"],
      info: {
        kicker: "deploy/compose.yml",
        title: "Storage",
        lead: "PostgreSQL holds the books and the orders; a nightly job dumps it.",
        see: ["db", "backup"],
        src: "deploy/compose.yml",
      },
    },
  ],
  nodes: [
    {
      zone: "clients",
      id: "browser",
      label: "Browser",
      sub: "computer or phone",
      info: {
        title: "Reader's browser",
        lead: "The reader opens the shop's address. Pages are HTML rendered on the server.",
        io: [
          ["Sends", "clicks, searches, the order form"],
          ["Receives", "pages and a session cookie"],
        ],
      },
      color: "--z-olive",
      couples: [],
    },
    {
      zone: "server",
      id: "proxy",
      label: "Reverse proxy",
      sub: "Caddy · TLS",
      info: {
        kicker: "deploy/Caddyfile",
        title: "Reverse proxy",
        lead: "Caddy ends HTTPS, renews the certificate and forwards each request to the application.",
        io: [
          ["Receives", "HTTPS on port 443"],
          ["Produces", "HTTP to <code>app:3000</code>"],
        ],
        swap: "The Caddyfile and the proxy service of <code>deploy/compose.yml</code>.",
        pitfalls: ["The certificate renews only while port 80 is reachable from outside."],
        src: "deploy/Caddyfile",
      },
      color: "--z-brown",
      couples: ["web"],
    },
    {
      zone: "app",
      id: "web",
      label: "Web routes",
      sub: "src/web.ts",
      info: {
        kicker: "src/web.ts",
        title: "Web routes",
        lead: "Maps each URL to a page or a form handler, and renders the HTML.",
        io: [
          ["Receives", "HTTP requests"],
          ["Produces", "HTML pages, calls to the catalog and the orders"],
        ],
        extend: "A page = a route in <code>src/web.ts</code> and its template.",
      },
      color: "--z-blue",
      couples: [],
    },
    {
      zone: "app",
      id: "catalog",
      label: "Catalog",
      sub: "src/catalog.ts",
      info: {
        kicker: "src/catalog.ts",
        title: "Catalog",
        lead: "Lists, searches and shows the books.",
        io: [
          ["Receives", "a search or a book id"],
          ["Produces", "books with their price and stock"],
        ],
        see: ["db"],
      },
      color: "--z-blue",
      couples: ["db"],
    },
    {
      zone: "app",
      id: "orders",
      label: "Orders",
      sub: "src/orders.ts",
      info: {
        kicker: "src/orders.ts",
        title: "Orders",
        lead: "Takes an order, lowers the stock and sends the confirmation mail.",
        io: [
          ["Receives", "a cart and a delivery address"],
          ["Produces", "an order row, a confirmation mail"],
        ],
        pitfalls: [
          "The mail is sent before the request answers: a slow email service slows the checkout.",
        ],
        alt: "A queue between the order and its mail, postponed while orders stay few.",
      },
      color: "--z-blue",
      couples: ["db", "email"],
    },
    {
      zone: "data",
      id: "db",
      label: "Database",
      sub: "PostgreSQL\nbooks · orders",
      info: {
        kicker: "deploy/compose.yml",
        title: "Database",
        lead: "One PostgreSQL database, two tables: books and orders.",
        facts: [["Volume", "pgdata"]],
      },
      color: "--z-indigo",
      couples: [],
    },
    {
      zone: "data",
      id: "backup",
      label: "Nightly backup",
      sub: "pg_dump · cron",
      info: {
        kicker: "deploy/backup.sh",
        title: "Nightly backup",
        lead: "Dumps the database each night to a file on the same machine.",
        open: [
          {
            id: "backup-restore-untested",
            text: "No restore from the nightly dump has been tried: whether a dump restores is unknown.",
          },
        ],
      },
      color: "--z-indigo",
      couples: ["db"],
      kind: "off",
    },
    {
      zone: null,
      id: "email",
      label: "Email service",
      sub: "transactional mail API",
      info: {
        title: "Email service",
        lead: "An outside service that delivers the order confirmations.",
        io: [
          ["Receives", "the reader's address and the order summary"],
          ["Produces", "a delivered mail"],
        ],
        swap: "The mail client in <code>src/orders.ts</code> and its key in <code>deploy/.env</code>.",
      },
      color: "--z-grey",
      side: "out",
      couples: [],
    },
  ],
  edges: [
    { from: "z:app", to: "z:data", label: "SQL" },
    { from: "z:app", to: "email", label: "order mail" },
    { from: "browser", to: "proxy", label: "HTTPS" },
    { from: "proxy", to: "web", label: "HTTP app:3000" },
    { from: "web", to: "catalog", label: "list, search" },
    { from: "web", to: "orders", label: "checkout" },
    { from: "catalog", to: "db", label: "SQL books" },
    { from: "orders", to: "db", label: "SQL orders" },
    { from: "orders", to: "email", label: "confirmation", data: ["account", "order"] },
    { from: "backup", to: "db", label: "pg_dump each night", kind: "dash" },
  ],
  zoneOrder: ["clients", "server", "app", "data"],
};

const CONFIG: Config = { palette: { c: "--z-blue" } };

const leaf = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  label: id,
  sub: "",
  color: "c",
  ...extra,
});

const holder = (id: string, children: readonly Node[], extra: Partial<Node> = {}): Node =>
  leaf(id, { ...extra, children });

const mapOf = (children: readonly Node[], links: readonly Link[] = []): AtlasMap => ({
  root: { title: "T", children },
  links,
});

const server = (inner: readonly Node[]): Node => holder("srv", [holder("zone", inner)]);

describe("toPlan", () => {
  test("the sample map is the plan written out by hand", () => {
    expect(toPlan(map, config)).toStrictEqual(SAMPLE);
  });

  test("the zone tour is the root's tour when it has one", () => {
    const m: AtlasMap = {
      root: { title: "T", tour: ["zone", "srv"], children: [server([leaf("a")])] },
      links: [],
    };

    expect(toPlan(m, CONFIG).zoneOrder).toEqual(["zone", "srv"]);
  });

  test.each([
    [
      "a duplicate id",
      mapOf([server([leaf("a"), leaf("a")])]),
      "node a: a second node has this id",
    ],
    [
      "a link end that is no node",
      mapOf([server([leaf("a")])], [{ from: "a", to: "nowhere", label: "x" }]),
      "link a → nowhere: no node nowhere",
    ],
    [
      "a color outside the palette",
      mapOf([server([leaf("a", { color: "pink" })])]),
      "node a: color pink is not in the palette",
    ],
    [
      "an outside node below the root",
      mapOf([server([leaf("a", { outside: true, side: "out" })])]),
      "node a: only a child of the root is outside",
    ],
    [
      "a side on a node that is not outside",
      mapOf([server([leaf("a", { side: "in" })])]),
      "node a: side is for an outside node",
    ],
    [
      "a leaf under the root that is not outside",
      mapOf([server([leaf("a")]), leaf("b")]),
      "node b: a leaf under the root must be outside; otherwise it sits in a node with children",
    ],
    [
      "a brief on a leaf",
      mapOf([server([leaf("a", { brief: ["x"] })])]),
      "node a: brief is for a node with children",
    ],
    [
      "an empty children list",
      mapOf([server([holder("a", [])])]),
      "node a: children is empty; a leaf has no children field",
    ],
    [
      "couples on a node with children",
      mapOf([holder("srv", [holder("zone", [leaf("a")], { couples: ["a"] })])]),
      "node zone: couples and kind are for a leaf",
    ],
    [
      "kind on a node with children",
      mapOf([holder("srv", [holder("zone", [leaf("a")], { kind: "off" })])]),
      "node zone: couples and kind are for a leaf",
    ],
    [
      'side "both" on a node with children',
      mapOf([server([leaf("a")]), holder("out", [leaf("b")], { outside: true, side: "both" })]),
      'node out: side "both" is for an outside leaf',
    ],
    [
      "an outside node holding a node with children",
      mapOf([
        server([leaf("a")]),
        holder("out", [holder("inner", [leaf("b")])], { outside: true, side: "in" }),
      ]),
      "node out: an outside node holds leaves only, and inner has children",
    ],
    [
      "a node under the root, not outside, without a child with children",
      mapOf([holder("srv", [leaf("a")])]),
      "node srv: a node under the root that is not outside needs a child with children: the overview draws its own leaves in a block beside those (srv~own)",
    ],
  ])("refuses %s", (_, m, message) => {
    expect(() => toPlan(m, CONFIG)).toThrow(message);
  });
});
