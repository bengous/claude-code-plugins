CREATE TABLE books (
  id    text PRIMARY KEY,
  title text NOT NULL,
  price integer NOT NULL,
  stock integer NOT NULL CHECK (stock >= 0)
);

CREATE TABLE orders (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
