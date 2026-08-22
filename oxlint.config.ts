import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    "archive/**",
    "_docs/**",
    "node_modules/**",
    // Vendored third party, upstream owns the style.
    "tools/oxlint/anti-slop/**",
    "claude-meta-tools/scripts/prompt-extractor/promptExtractor.js",
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

    // CLAUDE.md asks for TODO/FIXME markers on deferred and security work.
    "no-warning-comments": "off",

    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
