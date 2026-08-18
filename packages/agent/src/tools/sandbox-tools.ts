// The four workspace tools — bash, read, write, edit — as pi-contract
// wrappers over the Sandbox handle. The spec/executable split does its
// job here: `sandboxToolSpecs` is static (the inference branch declares
// tools without ever touching a sandbox), `createSandboxTools` binds the
// executables to a handle per step. Both project from the same
// definition constants, so spec and executable cannot drift.

import { type Tool, type ToolDefinition, toToolSpec } from "../engine/tool";
import type { Sandbox } from "../ports/sandbox-provider";
import type { ToolSpec } from "@funky/core";
import { bashDefinition, bindBash } from "./bash";
import { createFileQueue } from "./file-queue";
import { bindEdit, editDefinition } from "./edit";
import { bindRead, readDefinition } from "./read";
import { bindWrite, writeDefinition } from "./write";

const definitions: ToolDefinition[] = [
  bashDefinition,
  readDefinition,
  writeDefinition,
  editDefinition,
];

export const sandboxToolSpecs: ToolSpec[] = definitions.map(toToolSpec);

export function createSandboxTools(sandbox: Sandbox): Map<string, Tool> {
  const queue = createFileQueue();
  const tools = [
    bindBash(sandbox),
    bindRead(sandbox),
    bindWrite(sandbox, queue),
    bindEdit(sandbox, queue),
  ];
  return new Map(tools.map((tool) => [tool.name, tool]));
}
