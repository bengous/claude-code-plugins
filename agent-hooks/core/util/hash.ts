import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const DELETED = "deleted";

export function hashFile(absolutePath: string): string {
  try {
    return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  } catch {
    return DELETED;
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
