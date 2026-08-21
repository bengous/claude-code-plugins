import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const script = join(import.meta.dir, "plugin-cache-sync");
const tempDirectories: string[] = [];

async function createFixture(): Promise<{
  cacheDirectory: string;
  home: string;
  repository: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "plugin-cache-sync-test-"));
  tempDirectories.push(root);

  const home = join(root, "home");
  const repository = join(root, "marketplace");
  const pluginSource = join(repository, "demo");
  const cacheDirectory = join(
    home,
    ".claude/plugins/cache",
    basename(repository),
    "demo/1.0.0",
  );

  await mkdir(join(repository, ".claude-plugin"), { recursive: true });
  await mkdir(pluginSource, { recursive: true });
  await mkdir(join(home, ".claude/plugins"), { recursive: true });
  await Bun.write(join(pluginSource, "content.txt"), "current\n");
  await Bun.write(
    join(repository, ".claude-plugin/marketplace.json"),
    JSON.stringify({
      plugins: [{ name: "demo", version: "1.0.0", source: "./demo" }],
    }),
  );
  await mkdir(dirname(cacheDirectory), { recursive: true });
  await cp(pluginSource, cacheDirectory, { recursive: true });
  await Bun.write(
    join(home, ".claude/plugins/installed_plugins.json"),
    JSON.stringify({
      plugins: {
        [`demo@${basename(repository)}`]: [
          {
            installPath: cacheDirectory,
            version: "1.0.0",
            gitCommitSha: "0000000000000000000000000000000000000000",
          },
        ],
      },
    }),
  );
  await Bun.write(join(home, ".claude/settings.json"), "{}\n");

  const git = async (...arguments_: string[]) => {
    const process = Bun.spawn(["git", ...arguments_], {
      cwd: repository,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await process.exited).toBe(0);
  };
  await git("init", "--quiet");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "fixture");

  return { cacheDirectory, home, repository };
}

async function status(home: string, repository: string): Promise<string> {
  const child = Bun.spawn(["bash", script, "--source", repository, "status"], {
    env: { ...process.env, HOME: home },
    stderr: "pipe",
    stdout: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return output;
}

async function sync(home: string, repository: string): Promise<void> {
  const child = Bun.spawn(
    ["bash", script, "--source", repository, "sync", "demo"],
    {
      env: { ...process.env, HOME: home },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  expect(await child.exited).toBe(0);
}

async function readRegistry(home: string): Promise<any> {
  return JSON.parse(
    await Bun.file(join(home, ".claude/plugins/installed_plugins.json")).text(),
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("plugin-cache-sync status", () => {
  test("ignores a provenance SHA mismatch when cached content matches", async () => {
    const fixture = await createFixture();

    const output = await status(fixture.home, fixture.repository);

    expect(output).toContain("OK");
    expect(output).not.toContain("STALE");
  });

  test("reports stale content when the cache differs from source", async () => {
    const fixture = await createFixture();
    await Bun.write(join(fixture.cacheDirectory, "content.txt"), "stale\n");

    const output = await status(fixture.home, fixture.repository);

    expect(output).toContain("STALE");
    expect(output).toContain("content");
  });
});

describe("plugin-cache-sync sync", () => {
  test("creates a complete registry entry for a never-installed plugin", async () => {
    const fixture = await createFixture();
    await Bun.write(
      join(fixture.home, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ plugins: {} }),
    );

    await sync(fixture.home, fixture.repository);

    const registry = await readRegistry(fixture.home);
    const entry = registry.plugins[`demo@${basename(fixture.repository)}`][0];
    expect(entry.scope).toBe("user");
    expect(entry.installPath).toBe(fixture.cacheDirectory);
    expect(entry.version).toBe("1.0.0");
    expect(entry.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.gitCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("updates an existing entry without dropping fields it does not manage", async () => {
    const fixture = await createFixture();
    const key = `demo@${basename(fixture.repository)}`;
    await Bun.write(
      join(fixture.home, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({
        plugins: {
          [key]: [
            {
              scope: "user",
              installPath: fixture.cacheDirectory,
              version: "1.0.0",
              installedAt: "2026-01-01T00:00:00.000Z",
              lastUpdated: "2026-01-01T00:00:00.000Z",
              gitCommitSha: "0000000000000000000000000000000000000000",
              devMode: true,
              cachedPath: "/stale/path",
            },
          ],
        },
      }),
    );

    await sync(fixture.home, fixture.repository);

    const entry = (await readRegistry(fixture.home)).plugins[key][0];
    expect(entry.scope).toBe("user");
    expect(entry.installedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.lastUpdated).not.toBe("2026-01-01T00:00:00.000Z");
    expect(entry.gitCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.devMode).toBeUndefined();
    expect(entry.cachedPath).toBeUndefined();
  });

  test("prunes every cached version except the one being synced", async () => {
    const fixture = await createFixture();
    const versionsDirectory = dirname(fixture.cacheDirectory);
    await mkdir(join(versionsDirectory, "0.9.0"), { recursive: true });
    await mkdir(join(versionsDirectory, "0.9.1"), { recursive: true });

    await sync(fixture.home, fixture.repository);

    expect((await readdir(versionsDirectory)).sort()).toEqual(["1.0.0"]);
  });
});
