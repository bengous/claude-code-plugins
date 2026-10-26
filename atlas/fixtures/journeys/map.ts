import type { AtlasMap } from "../../src/model/atlas.ts";

export default {
  root: {
    title: "Journeys",
    lead: "A bookshop whose root declares two journeys. The Parcours menu in the header plays one step by step: each step opens the deepest view that shows both its ends and lights its arrow. Data's leaves have cards, to start a journey from them, and the arrow of Place an order's step 7 comes after the phase MVP.",
    journeys: [
      {
        id: "place-order",
        label: "Place an order",
        steps: [
          {
            from: "reader",
            to: "proxy",
            note: "The reader's browser opens the shop over HTTPS.",
          },
          {
            from: "proxy",
            to: "routes",
            note: "The proxy ends TLS and forwards the request to the application.",
          },
          { from: "routes", to: "cart", note: "The route adds the book to the cart." },
          { from: "cart", to: "pricing", note: "Checking out hands the cart to the pricing." },
          { from: "pricing", to: "payment", note: "The total, taxes included, goes to payment." },
          { from: "payment", to: "db", note: "A captured payment writes the order." },
          { from: "db", to: "outbox", note: "The order row queues its confirmation." },
          { from: "outbox", to: "mailer", note: "The outbox hands the mail to the mail service." },
        ],
      },
      {
        id: "sign-in",
        label: "Sign in",
        steps: [
          { from: "reader", to: "proxy" },
          { from: "proxy", to: "routes" },
          { from: "routes", to: "session", note: "The sign-in form posts to the session." },
          { from: "session", to: "db", note: "The session row is written, then read back." },
        ],
      },
    ],
    children: [
      {
        id: "reader",
        label: "Reader",
        sub: "a browser",
        color: "outside",
        outside: true,
        side: "in",
      },
      {
        id: "edge",
        label: "Edge",
        sub: "in front of the shop",
        color: "edge",
        children: [
          { id: "cdn", label: "CDN", sub: "static files", color: "edge" },
          { id: "proxy", label: "Proxy", sub: "TLS · routing", color: "edge" },
        ],
      },
      {
        id: "app",
        label: "Application",
        sub: "one Bun process",
        color: "app",
        children: [
          {
            id: "web",
            label: "Web",
            sub: "pages and forms",
            color: "app",
            children: [
              { id: "routes", label: "Routes", sub: "src/web/routes.ts", color: "app" },
              { id: "session", label: "Session", sub: "signed cookies", color: "app" },
            ],
          },
          {
            id: "shop",
            label: "Shop",
            sub: "what is sold",
            color: "shop",
            children: [
              { id: "cart", label: "Cart", sub: "what the reader picks", color: "shop" },
              {
                id: "checkout",
                label: "Checkout",
                sub: "from cart to order",
                color: "shop",
                children: [
                  { id: "pricing", label: "Pricing", sub: "totals and taxes", color: "shop" },
                  { id: "payment", label: "Payment", sub: "card capture", color: "shop" },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "data",
        label: "Data",
        sub: "the state",
        color: "data",
        children: [
          {
            id: "db",
            label: "Database",
            sub: "PostgreSQL",
            color: "data",
            io: [
              ["Receives", "orders, sessions"],
              ["Produces", "an order placed"],
            ],
          },
          {
            id: "outbox",
            label: "Outbox",
            sub: "mails to send",
            color: "data",
            io: [
              ["Receives", "an order placed"],
              ["Produces", "a confirmation"],
            ],
          },
        ],
      },
      {
        id: "bank",
        label: "Card network",
        sub: "card payments",
        color: "outside",
        outside: true,
        side: "out",
      },
      {
        id: "mailer",
        label: "Mail service",
        sub: "transactional mail",
        color: "outside",
        outside: true,
        side: "out",
      },
    ],
  },
  links: [
    { from: "reader", to: "cdn", label: "assets" },
    { from: "reader", to: "proxy", label: "HTTPS" },
    { from: "proxy", to: "routes", label: "HTTP" },
    { from: "routes", to: "session", label: "sign in" },
    { from: "db", to: "session", label: "sessions", two: true },
    { from: "routes", to: "cart", label: "add to cart" },
    { from: "cart", to: "pricing", label: "check out" },
    { from: "pricing", to: "payment", label: "total" },
    { from: "payment", to: "bank", label: "charge" },
    { from: "payment", to: "db", label: "write order" },
    { from: "db", to: "outbox", label: "order placed", phase: "v2" },
    { from: "outbox", to: "mailer", label: "confirmation" },
  ],
} satisfies AtlasMap;
