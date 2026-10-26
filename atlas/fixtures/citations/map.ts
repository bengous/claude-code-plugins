import type { AtlasMap } from "../../src/model/atlas.ts";

export default {
  root: {
    title: "Shop",
    lead: "A shop in Go: one process serves the routes and takes the orders <cite>cmd/shop/main.go:15-24</cite>, PostgreSQL keeps the books and the orders <cite>db/schema.sql:1-12</cite>, and a mail service sends the confirmations <cite>orders/mail.go:22-41</cite>.",
    how: "Each claim ends with its citation: its lines as a marker, the whole citation as its tooltip.",
    src: "cmd/shop/main.go",
    children: [
      {
        id: "app",
        label: "Application",
        sub: "one Go process",
        color: "app",
        brief: ["routes", "orders", "mail client"],
        lead: "One process: <code>main</code> opens the database and serves the routes on port 3000 <cite>cmd/shop/main.go:16-23</cite>.",
        src: "cmd/shop/main.go",
        children: [
          {
            id: "routes",
            label: "Routes",
            sub: "web/routes.go",
            color: "app",
            lead: "Maps each URL to its handler <cite>web/routes.go:11-16</cite>.",
            io: [
              ["Receives", "a cart as JSON <cite>web/routes.go:25-29</cite>"],
              [
                "Produces",
                "the order's id, or the reason it was refused <cite>web/routes.go:31-37</cite>",
              ],
            ],
            src: "web/routes.go",
          },
          {
            id: "orders",
            label: "Orders",
            sub: "orders/orders.go",
            color: "app",
            kicker: "orders/orders.go:25-55",
            lead: "Writes an order and lowers the stock in one transaction <cite>orders/orders.go:26-51</cite>, then asks the mailer for the confirmation <cite>orders/orders.go:53-54</cite>.",
            io: [
              [
                "Receives",
                "an email and the cart's lines, from the checkout route <cite>web/routes.go:31</cite>",
              ],
              [
                "Produces",
                "an order row <cite>orders/orders.go:32-36</cite> and a confirmation mail <cite>orders/mail.go:22-41</cite>",
              ],
            ],
            swap: "The <code>Service</code> struct and its two fields <cite>orders/orders.go:19-22</cite>, which <code>main</code> builds <cite>cmd/shop/main.go:21</cite>.",
            pitfalls: [
              "A line asking more copies than the shelf holds rolls the whole order back <cite>orders/orders.go:30,44-46</cite>.",
              "The mail goes out before the request answers: a slow mail service slows the checkout <cite>orders/orders.go:53-54</cite>.",
            ],
            why: [
              "One transaction keeps the stock and the orders in step <cite>orders/orders.go:26,49</cite>.",
            ],
            alt: "A queue between the order and its mail, postponed while orders stay few <cite>the shop's notes</cite>.",
            src: "orders/orders.go",
          },
          {
            id: "mailer",
            label: "Mail client",
            sub: "orders/mail.go",
            color: "app",
            lead: "Posts each confirmation to the mail service <cite>orders/mail.go:22-41</cite>, with the key from <code>MAIL_KEY</code> <cite>orders/mail.go:28</cite>.",
            swap: "Any type with a <code>Confirm</code> method <cite>orders/mail.go:13-15</cite>.",
            src: "orders/mail.go",
          },
        ],
      },
      {
        id: "db",
        label: "Database",
        sub: "PostgreSQL",
        color: "data",
        lead: "Two tables: books, with their stock <cite>db/schema.sql:1-6</cite>, and orders <cite>db/schema.sql:8-12</cite>.",
        pitfalls: ["A stock never goes below zero <cite>db/schema.sql:5</cite>."],
        src: "db/schema.sql",
      },
      {
        id: "mail",
        label: "Mail service",
        sub: "transactional mail API",
        color: "outside",
        outside: true,
        side: "out",
        lead: "Delivers the confirmations; the mail client reaches it at <code>MAIL_URL</code> <cite>cmd/shop/main.go:21</cite>.",
      },
    ],
  },
  links: [
    { from: "routes", to: "orders", label: "checkout" },
    { from: "orders", to: "mailer", label: "confirm" },
    { from: "orders", to: "db", label: "SQL" },
    { from: "mailer", to: "mail", label: "HTTPS" },
  ],
} satisfies AtlasMap;
