import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const script = join(import.meta.dir, "plugin-dev");
const tempDirectories: string[] = [];

async function createFixture(): Promise<{
  cacheDirectory: string;
  home: string;
  repository: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "plugin-dev-test-"));
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

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("plugin-dev status", () => {
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
