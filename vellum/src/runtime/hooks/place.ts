import type { Host } from "./host.ts";
import type { Landed, Platform } from "./lock.ts";
import type { ProjectDir } from "./parse.ts";

/**
 * A missing name Windows reads off the folder it seems to be in: `D:x` lands in drive D's own
 * directory, and `C:stream` names a drive or a stream. The engine's guard recipe (`$.fs.stat`
 * in `claude-code.d.ts`) refuses both.
 */
const DRIVE_NAME = /^[A-Za-z]:/u;

/** Rooted on POSIX, on a Windows drive, or on the session's drive without naming it. */
const ROOTED = /^(?:[\\/]|[A-Za-z]:[\\/])/u;

/** Windows ends a name on `\` as well as `/`; on POSIX `\` is a character of a name. */
const SEPARATORS = {
  posix: { last: /\/(?=[^/]*$)/u, trailing: /\/+$/u },
  windows: { last: /[\\/](?=[^\\/]*$)/u, trailing: /[\\/]+$/u },
} as const;

/** The engine ends its rejection of a missing path on the errno, and sets no `code`. */
const NOT_THERE = / failed: ENOENT$/u;

/**
 * What `stat` says of a path: where it lands, or that it is not there. `refused` is any other
 * rejection (another errno, a hook above), which says nothing of where the path lands.
 */
type Asked =
  | { readonly kind: "found"; readonly realPath: string | undefined }
  | { readonly kind: "missing" }
  | { readonly kind: "refused" };

async function asked(host: Host, path: string): Promise<Asked> {
  try {
    return { kind: "found", realPath: (await host.stat(path)).realPath };
  } catch (error) {
    return error instanceof Error && NOT_THERE.test(error.message)
      ? { kind: "missing" }
      : { kind: "refused" };
  }
}

/**
 * Where a path lands, as the file system answers it: every symbolic link followed, whatever
 * the platform's spelling. A file not written yet lands under the first of its folders that
 * exists. `null` when nothing can tell: a link that leads nowhere, a stat refused for another
 * reason than a missing path, a network or device path, a name Windows reads as a drive. The
 * lock denies on `null`, since the tool may still open it.
 */
export async function placed(host: Host, path: string, platform: Platform): Promise<string | null> {
  const { last, trailing } = SEPARATORS[platform];
  const missing: string[] = [];
  let rest = path;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a folder is asked only once what it holds is known to be missing.
    const found = await asked(host, rest);

    if (found.kind === "refused") return null;

    if (found.kind === "found") {
      return found.realPath === undefined
        ? null
        : [found.realPath.replace(trailing, ""), ...missing].join("/");
    }

    const named = rest.replace(trailing, "");
    const cut = named.search(last);
    const name = named.slice(cut + 1);

    if (name === "" || name === "." || name === ".." || DRIVE_NAME.test(name)) return null;
    missing.unshift(name);
    rest = cut < 0 ? "." : named.slice(0, cut + 1);
  }
}

/**
 * Where a call's file and the project land. The project's `realPath` also says the platform:
 * POSIX answers it from `/`, Windows from a drive or a share. A relative path hangs off the
 * session's directory, read for that path alone. A project that cannot be placed throws, and
 * the lock fails closed on it.
 */
export async function landed(
  host: Host,
  session: { readonly project: ProjectDir },
  path: string,
): Promise<Landed> {
  const project = (await host.stat(session.project)).realPath;

  if (project === undefined) {
    throw new Error(
      `the project ${session.project} lands nowhere: \`$.fs.stat\` answered no \`realPath\`, as an engine older than the one \`types/claude-code.d.ts\` was written by does`,
    );
  }

  const platform = project.startsWith("/") ? "posix" : "windows";

  const whole = ROOTED.test(path)
    ? path
    : `${(await host.cwd()).replace(SEPARATORS[platform].trailing, "")}/${path}`;

  return { file: await placed(host, whole, platform), project, platform };
}
