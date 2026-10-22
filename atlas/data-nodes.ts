import type { Brick, Section } from "./model.ts";
import { brickAdder } from "./model.ts";

// One brick = one component or feature that can be replaced or removed on
// its own, never a file. Keep implementation details inside the `info` of
// the brick they belong to rather than as bricks of their own.
//
// add(zone, id, label, sub, info, options), typed in model.ts
//   zone     zone id, or null for a third-party service outside every zone
//   label    short name: the overview shows it, so keep it to a few words
//   sub      mono subtitle, "\n" between lines, shown in the detail and the panel
//   info     panel content, fields listed at the top of data-zones.ts
//   options  color: a --z-* token; kind: "off" for a dormant brick (dashed);
//            side: for a service outside every zone, its overview column:
//            "in" (left), "out" (right) or "both";
//            couples: ids of bricks that must change when this one is
//            replaced. A coupling needs to be listed on one side only; the
//            engine makes it symmetric.
export const bricks: Brick[] = [];

const add = brickAdder(bricks);

const CLIENTS: Section = { color: "--z-olive" };

const SERVER: Section = { color: "--z-brown" };

const APP: Section = { color: "--z-blue" };

const DATA: Section = { color: "--z-indigo" };

add(
  "clients",
  "browser",
  "Browser",
  "computer or phone",
  {
    title: "Reader's browser",
    lead: "The reader opens the shop's address. Pages are HTML rendered on the server.",
    io: [
      ["Sends", "clicks, searches, the order form"],
      ["Receives", "pages and a session cookie"],
    ],
  },
  { ...CLIENTS, couples: [] },
);

add(
  "server",
  "proxy",
  "Reverse proxy",
  "Caddy · TLS",
  {
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
  { ...SERVER, couples: ["web"] },
);

add(
  "app",
  "web",
  "Web routes",
  "src/web.ts",
  {
    kicker: "src/web.ts",
    title: "Web routes",
    lead: "Maps each URL to a page or a form handler, and renders the HTML.",
    io: [
      ["Receives", "HTTP requests"],
      ["Produces", "HTML pages, calls to the catalog and the orders"],
    ],
    extend: "A page = a route in <code>src/web.ts</code> and its template.",
  },
  { ...APP, couples: [] },
);

add(
  "app",
  "catalog",
  "Catalog",
  "src/catalog.ts",
  {
    kicker: "src/catalog.ts",
    title: "Catalog",
    lead: "Lists, searches and shows the books.",
    io: [
      ["Receives", "a search or a book id"],
      ["Produces", "books with their price and stock"],
    ],
    see: ["db"],
  },
  { ...APP, couples: ["db"] },
);

add(
  "app",
  "orders",
  "Orders",
  "src/orders.ts",
  {
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
  { ...APP, couples: ["db", "email"] },
);

add(
  "data",
  "db",
  "Database",
  "PostgreSQL\nbooks · orders",
  {
    kicker: "deploy/compose.yml",
    title: "Database",
    lead: "One PostgreSQL database, two tables: books and orders.",
    facts: [["Volume", "pgdata"]],
  },
  { ...DATA, couples: [] },
);

add(
  "data",
  "backup",
  "Nightly backup",
  "pg_dump · cron",
  {
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
  { ...DATA, couples: ["db"], kind: "off" },
);

add(
  null,
  "email",
  "Email service",
  "transactional mail API",
  {
    title: "Email service",
    lead: "An outside service that delivers the order confirmations.",
    io: [
      ["Receives", "the reader's address and the order summary"],
      ["Produces", "a delivered mail"],
    ],
    swap: "The mail client in <code>src/orders.ts</code> and its key in <code>deploy/.env</code>.",
  },
  { color: "--z-grey", side: "out", couples: [] },
);
