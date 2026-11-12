import { describe, expect, test } from "bun:test";

import { blankNoise, importsOf, pythonLinks } from "./extract-python.ts";

describe("blankNoise", () => {
  test("blanks strings and comments, keeps code and newlines", () => {
    const source = 'x = "a#b"  # note\n"""doc\nimport os\n"""\ny = 1\n';
    const blanked = blankNoise(source);

    expect(blanked).toHaveLength(source.length);
    expect(blanked.split("\n")).toHaveLength(source.split("\n").length);
    expect(blanked).not.toContain("import os");
    expect(blanked).toContain("x = ");
    expect(blanked).toContain("y = 1");
  });

  test("an escaped quote does not end the string", () => {
    expect(blankNoise(String.raw`s = "a\"import b" + c`)).toContain("+ c");
  });
});

describe("importsOf", () => {
  test("reads from-imports, plain imports, aliases, relative levels and parenthesised lists", () => {
    const source = [
      "import os.path, json as j",
      "from . import sibling",
      "from ..pkg.mod import (",
      "    a as b,",
      "    c,",
      ")",
      "if x:",
      "    from mod import *",
    ].join("\n");

    expect(importsOf(source)).toEqual([
      { level: 1, module: [], names: ["sibling"] },
      { level: 2, module: ["pkg", "mod"], names: ["a", "c"] },
      { level: 0, module: ["mod"], names: ["*"] },
      { level: 0, module: ["os", "path"], names: [null] },
      { level: 0, module: ["json"], names: [null] },
    ]);
  });

  test("an import inside a docstring is no import", () => {
    expect(importsOf('"""\nfrom app import x\n"""\n')).toEqual([]);
  });
});

describe("pythonLinks", () => {
  const files = new Map([
    ["app/__init__.py", ""],
    ["app/core/__init__.py", "from .db import connect\n"],
    ["app/core/db.py", "import json\n"],
    [
      "app/orders/store.py",
      "from app.core import db\nfrom ..core.db import connect\nfrom . import api\n",
    ],
    ["app/orders/api.py", "from app.orders.store import Store\n"],
    ["app/main.py", "import app.orders.api\nfrom app import core\n"],
  ]);

  test("resolves package-qualified, relative and submodule imports, and leaves the rest out", () => {
    expect(pythonLinks(files, null)).toEqual([
      ["app/core/__init__.py", "app/core/db.py"],
      ["app/main.py", "app/core/__init__.py"],
      ["app/main.py", "app/orders/api.py"],
      ["app/orders/api.py", "app/orders/store.py"],
      ["app/orders/store.py", "app/core/db.py"],
      ["app/orders/store.py", "app/orders/api.py"],
    ]);
  });

  test("the package prefix maps to the root when paths are relative to the package", () => {
    const inside = new Map([
      ["core/db.py", ""],
      ["orders/store.py", "from app.core.db import connect\n"],
    ]);

    expect(pythonLinks(inside, "app")).toEqual([["orders/store.py", "core/db.py"]]);
    expect(pythonLinks(inside, null)).toEqual([]);
  });
});

describe("package names and the root package", () => {
  test("a dotted --package maps its whole prefix to the root", () => {
    const files = new Map([
      ["core/db.py", ""],
      ["orders/store.py", "from company.myapp.core.db import connect\n"],
    ]);

    expect(pythonLinks(files, "company.myapp")).toEqual([["orders/store.py", "core/db.py"]]);
  });

  test("a name imported from the root package resolves to its __init__.py", () => {
    const files = new Map([
      ["__init__.py", "VERSION = 1\n"],
      ["cli.py", "from myapp import VERSION\n"],
      ["web.py", "from . import VERSION\n"],
    ]);

    expect(pythonLinks(files, "myapp")).toEqual([
      ["cli.py", "__init__.py"],
      ["web.py", "__init__.py"],
    ]);
  });
});
