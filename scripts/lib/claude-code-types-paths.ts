/**
 * Where vellum keeps its copy of the Claude Code plugin API. A module of its own, importing
 * nothing, so a reader of these paths does not load the types pipeline.
 */
export const TYPES_DIR = "vellum/types/";

export const TYPES_PATH = `${TYPES_DIR}claude-code.d.ts`;

export const TOOLS_TYPES_PATH = `${TYPES_DIR}claude-code-tools.d.ts`;
