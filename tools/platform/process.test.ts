import { describe, expect, test } from "bun:test";

import { LaunchError } from "./process.ts";
import { errnoOf } from "./pure.ts";

describe("LaunchError", () => {
  test("keeps the message, the cause and the errno of the error it wraps", () => {
    const cause = Object.assign(new Error("EACCES: permission denied, posix_spawn '/x'"), {
      code: "EACCES",
    });

    const error = new LaunchError(cause);

    expect(error.message).toBe(cause.message);
    expect(error.cause).toBe(cause);
    expect(error.code).toBe("EACCES");
    expect(errnoOf(error)).toBe("EACCES");
    expect(error.name).toBe("LaunchError");
  });

  test("reads the errno off the message when the wrapped error has no code, as errnoOf does", () => {
    const error = new LaunchError(new Error("spawn failed: ENOENT"));

    expect(errnoOf(error)).toBe("ENOENT");
    expect(new LaunchError("not an error").message).toBe("not an error");
  });
});
