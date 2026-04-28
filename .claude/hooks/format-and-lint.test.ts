import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hookPath = join(import.meta.dir, "format-and-lint.ts");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function createFixture(
	content: string,
	options: { lintShouldFail?: boolean } = {},
) {
	const dir = await mkdtemp(join(tmpdir(), "claude-format-hook-"));
	tempDirs.push(dir);
	await mkdir(join(dir, "_hooks-lib/node_modules/.bin"), { recursive: true });
	await mkdir(join(dir, "_hooks-lib/src"), { recursive: true });

	await Bun.write(
		join(dir, "_hooks-lib/node_modules/.bin/biome"),
		`#!/usr/bin/env bash
set -euo pipefail

command="$1"
file="\${@: -1}"

case "$command" in
	check)
		if grep -q 'const x=1' "$file"; then
			printf 'const x = 1;\\n' > "$file"
		fi
		;;
	lint)
		if [[ "${options.lintShouldFail ? "1" : "0"}" == "1" ]]; then
			echo "lint failed" >&2
			exit 1
		fi
		exit 0
		;;
	*)
		exit 1
		;;
esac
`,
	);

	await Bun.$`chmod +x ${join(dir, "_hooks-lib/node_modules/.bin/biome")}`;
	await Bun.write(join(dir, "_hooks-lib/src/example.ts"), content);

	return {
		dir,
		filePath: "_hooks-lib/src/example.ts",
	};
}

async function runHook(cwd: string, filePath: string) {
	const proc = Bun.spawn(["bun", hookPath], {
		cwd,
		stdin: new Blob([JSON.stringify({ tool_input: { file_path: filePath } })]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { exitCode, stdout, stderr };
}

describe("format-and-lint PostToolUse updatedToolOutput", () => {
	test("emits final file content when formatting changes the file", async () => {
		const { dir, filePath } = await createFixture("const x=1\n");

		const result = await runHook(dir, join(dir, filePath));

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				updatedToolOutput: "const x = 1;\n",
			},
		});
		expect(await Bun.file(join(dir, filePath)).text()).toBe("const x = 1;\n");
	});

	test("omits updatedToolOutput when formatting is idempotent", async () => {
		const { dir, filePath } = await createFixture("const x = 1;\n");

		const result = await runHook(dir, join(dir, filePath));

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect(await Bun.file(join(dir, filePath)).text()).toBe("const x = 1;\n");
	});

	test("preserves lint diagnostics and block exit when lint fails", async () => {
		const { dir, filePath } = await createFixture("const x=1\n", {
			lintShouldFail: true,
		});

		const result = await runHook(dir, join(dir, filePath));

		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("lint failed");
		expect(await Bun.file(join(dir, filePath)).text()).toBe("const x = 1;\n");
	});
});
