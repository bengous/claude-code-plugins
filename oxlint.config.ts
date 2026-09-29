import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    "archive/**",
    "node_modules/**",
    // Vendored third party, upstream owns the style.
    "tools/oxlint/anti-slop/**",
    // Written by `/plugin-types`, regenerated at each Claude Code update.
    "vellum/types/**",
  ],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  categories: {
    correctness: "error",
    suspicious: "error",
    pedantic: "error",
  },
  rules: {
    // Size metrics demand a structural rewrite of the script layer, which is
    // out of scope here. Re-enable them behind a dedicated refactor.
    "max-lines": "off",
    "max-lines-per-function": "off",
    "max-depth": "off",

    // The ASCII-diagram fixtures annotate each array line with the column the
    // line is testing. Moving those notes off the line loses that pairing.
    "no-inline-comments": "off",

    // A required `string | undefined` parameter needs an explicit `undefined`
    // argument. The rule reads the call site only, and its fix breaks the call.
    "unicorn/no-useless-undefined": ["error", { checkArguments: false }],

    // Its fix is not behaviour-preserving: parseInt("") is NaN but Number("")
    // is 0, which turns a rejected CLI argument into a valid zero. They also
    // disagree on "12abc" (12 vs NaN) and "0x10" (0 vs 16).
    "unicorn/prefer-number-coercion": "off",

    // Deferred work carries a TODO(#issue) marker in the source, as in
    // scripts/lint-shell.ts. The rule would reject every one of them.
    "no-warning-comments": "off",

    // Option semantics are inverted here: `true` bans the directive, `false`
    // allows it unconditionally. Spelling the policy out keeps it alive if
    // `pedantic` is ever lowered, which would otherwise drop it with no diff.
    "typescript/ban-ts-comment": [
      "error",
      {
        "ts-check": false,
        "ts-expect-error": "allow-with-description",
        "ts-ignore": true,
        "ts-nocheck": true,
        minimumDescriptionLength: 3,
      },
    ],

    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
  overrides: [
    {
      // A file of vellum holds one notion; past this size it holds two, and an agent reads the
      // whole of it to change one.
      files: ["vellum/src/**/*.ts", "vellum/src/**/*.tsx"],
      rules: { "max-lines": ["error", { max: 500 }] },
    },
    {
      // A suite grows with the behaviours it holds, one per test: its size says nothing of its notions.
      files: ["vellum/src/**/*.spec.ts", "vellum/src/**/*.test.ts", "vellum/src/**/fixtures/**"],
      rules: { "max-lines": "off" },
    },
    {
      // Over the size today, each a cut still to make:
      // - runtime/page/state.ts: the page's one store, the review's signals with the documents' since
      //   state.spec.ts imports it fresh per test, and a module it imports is shared by every store.
      // - runtime/server/queue.ts: the queue, the step, the channel, the draft and the view in one class.
      // - runtime/hooks/register.ts: every hook sits where `$` is spelled, which the engine requires
      //   of one file; what reads no `$` can leave it.
      // - steps/grill/page.tsx: the grill's renderer, band and panel in one half.
      // - formats/markdown/page.tsx: the renderer and the states of its sheet.
      // - formats/html/frame.ts: the script the mockup's frame runs, built by its path.
      files: [
        "vellum/src/runtime/page/state.ts",
        "vellum/src/runtime/server/queue.ts",
        "vellum/src/runtime/hooks/register.ts",
        "vellum/src/steps/grill/page.tsx",
        "vellum/src/formats/markdown/page.tsx",
        "vellum/src/formats/html/frame.ts",
      ],
      rules: { "max-lines": "off" },
    },
  ],
});
