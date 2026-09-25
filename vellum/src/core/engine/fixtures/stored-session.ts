import { CWD } from "./cwd.ts";
import { SERVER } from "./server.ts";
import { SESSION_ID } from "./session-id.ts";
import { WORKDIR } from "./workdir.ts";

export function storedSession(
  server: typeof SERVER = SERVER,
  project: string = CWD,
  workdir: string = WORKDIR,
  final: string | null = null,
) {
  return { [`session:${SESSION_ID}`]: { id: SESSION_ID, server, project, workdir, final } };
}
