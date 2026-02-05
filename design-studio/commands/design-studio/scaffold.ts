#!/usr/bin/env bun

import { parseArgs } from "util";
import { $ } from "bun";
import { mkdir, exists, writeFile } from "fs/promises";
import { join } from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

const mainTemplate = () => `import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Page1 from './pages/1'
import Page2 from './pages/2'
import Page3 from './pages/3'
import Page4 from './pages/4'
import Page5 from './pages/5'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/1" element={<Page1 />} />
        <Route path="/2" element={<Page2 />} />
        <Route path="/3" element={<Page3 />} />
        <Route path="/4" element={<Page4 />} />
        <Route path="/5" element={<Page5 />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)
`;

const pageTemplate = (n: number) => `export default function Page${n}() {
  return <div>Design ${n} - Placeholder</div>
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ScaffoldResult {
  project_path: string;
  state_path: string;
  pages: string[];
  dev_url: string | null;
  server_pid: number | null;
  created: boolean;
}

interface ErrorResult {
  error: string;
  details?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────────────────────

async function checkPortInUse(port: number): Promise<boolean> {
  try {
    const result = await $`lsof -i :${port} -t`.quiet();
    return result.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

async function scaffoldProject(projectPath: string): Promise<void> {
  if (await exists(projectPath)) {
    console.error(`Project already exists at ${projectPath}, skipping create-vite`);
    return;
  }

  console.error("Creating Vite project...");
  await $`bunx create-vite ${projectPath} --template react-ts`.quiet();

  console.error("Installing dependencies...");
  await $`bun install`.cwd(projectPath).quiet();

  console.error("Adding react-router-dom...");
  await $`bun add react-router-dom`.cwd(projectPath).quiet();
}

async function writeTemplates(projectPath: string): Promise<string[]> {
  const pagesDir = join(projectPath, "src", "pages");
  const createdFiles: string[] = [];

  // Create pages directory
  await mkdir(pagesDir, { recursive: true });

  // Write main.tsx
  const mainPath = join(projectPath, "src", "main.tsx");
  await writeFile(mainPath, mainTemplate());
  createdFiles.push(mainPath);

  // Write page templates
  for (let i = 1; i <= 5; i++) {
    const pagePath = join(pagesDir, `${i}.tsx`);
    await writeFile(pagePath, pageTemplate(i));
    createdFiles.push(pagePath);
  }

  return createdFiles;
}

async function createStateDir(statePath: string): Promise<void> {
  await mkdir(statePath, { recursive: true });
}

async function startDevServer(
  projectPath: string,
  port: number
): Promise<number | null> {
  // Check if already running
  if (await checkPortInUse(port)) {
    console.error(`Port ${port} already in use, assuming dev server is running`);
    return null;
  }

  console.error(`Starting dev server on port ${port}...`);

  // Start in background using Bun.spawn
  const proc = Bun.spawn(["bun", "run", "dev", "--port", String(port)], {
    cwd: projectPath,
    stdout: "ignore",
    stderr: "ignore",
  });

  // Give it a moment to start
  await Bun.sleep(2000);

  return proc.pid;
}

async function checkProject(projectPath: string): Promise<boolean> {
  return await exists(projectPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", default: "5173" },
    serve: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    project: { type: "string", default: "design-studio" },
    state: { type: "string", default: ".design-studio" },
  },
});

async function main(): Promise<void> {
  const port = parseInt(values.port!, 10);
  const projectPath = values.project!;
  const statePath = values.state!;

  try {
    // Check mode - just report if project exists
    if (values.check) {
      const projectExists = await checkProject(projectPath);
      const result = {
        exists: projectExists,
        project_path: projectPath,
        state_path: statePath,
      };
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Full scaffold mode
    await scaffoldProject(projectPath);
    const pages = await writeTemplates(projectPath);
    await createStateDir(statePath);

    let serverPid: number | null = null;
    let devUrl: string | null = null;

    if (values.serve) {
      serverPid = await startDevServer(projectPath, port);
      devUrl = `http://localhost:${port}`;
    }

    const result: ScaffoldResult = {
      project_path: projectPath,
      state_path: statePath,
      pages: pages.map((p) => p.replace(projectPath + "/", "")),
      dev_url: devUrl,
      server_pid: serverPid,
      created: true,
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const errorResult: ErrorResult = {
      error: error instanceof Error ? error.message : String(error),
      details: error instanceof Error ? error.stack : undefined,
    };
    console.log(JSON.stringify(errorResult, null, 2));
    process.exit(1);
  }
}

main();
