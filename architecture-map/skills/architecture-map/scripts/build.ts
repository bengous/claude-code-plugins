#!/usr/bin/env bun
/**
 * Build the interactive architecture map: graph.json (+ map.config.json) -> one HTML page.
 * Without a config, one view of the tree as measured. Every config key: references/config.md.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { writeAtomic } from "../../../lib/platform/fs.ts";
import {
  buildMap,
  type Graph,
  MapError,
  type MapConfig,
  previewPage,
  renderPage,
  reportLines,
} from "./map.ts";

const HELP = `build.ts --graph graph.json [--config map.config.json] --out map.html [--preview preview.html]

  --graph     graph.json from an extractor
  --config    map.config.json; without it, one view of the tree as measured
  --out       the HTML page to write, to publish as an artifact or open as a file
  --preview   also write a standalone copy to open over a local HTTP server
  --template  another page template (default: assets/template.html beside this script)`;

const TEMPLATE = join(import.meta.dir, "..", "assets", "template.html");

function readJson(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new MapError(`cannot read the ${what} ${path}`, { cause });
  }
}

function parseJson(text: string, path: string): Graph | MapConfig {
  try {
    // SAFETY: a JSON text of the shape references/config.md documents; buildMap reads each field
    // through optional chaining or a default, and a wrong shape fails there with the key named.
    return JSON.parse(text) as Graph | MapConfig;
  } catch (cause) {
    throw new MapError(`${path} is not valid JSON`, { cause });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      graph: { type: "string" },
      config: { type: "string" },
      out: { type: "string" },
      preview: { type: "string" },
      template: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help === true || values.graph === undefined || values.out === undefined) {
    console.log(HELP);
    process.exit(values.help === true ? 0 : 2);
  }

  // SAFETY: an extractor wrote this file in the Graph shape: nodes with path and size, edges as pairs.
  const graph = parseJson(readJson(values.graph, "graph"), values.graph) as Graph;

  // SAFETY: the config is optional and every key of MapConfig is optional too.
  const config = (
    values.config === undefined ? {} : parseJson(readJson(values.config, "config"), values.config)
  ) as MapConfig;

  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new MapError(
      `${values.graph} has no "nodes" or "edges" list: is it a graph from an extractor?`,
    );
  }

  const template = readFileSync(values.template ?? TEMPLATE, "utf8");
  const { data, report } = buildMap(graph, config);
  const html = renderPage(template, data, config);

  await writeAtomic(values.out, html, { mkdir: true });

  if (values.preview !== undefined)
    await writeAtomic(values.preview, previewPage(html), { mkdir: true });

  console.log(
    `built ${values.out}: ${html.length} bytes, ${report.files} files, ${report.links} links`,
  );

  for (const line of reportLines(report)) console.log(line);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof MapError)) throw error;
    console.error(`build: ${error.message}`);
    process.exit(1);
  }
}
