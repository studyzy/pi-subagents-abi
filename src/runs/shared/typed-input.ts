/**
 * Typed-input runtime for subagent ABI.
 *
 * When an agent declares `abi.input`, the parent validates the caller's `input`
 * and passes it to the child Pi process via a temp file + env var, mirroring the
 * existing structured-output transport. The child prompt-runtime reads the file
 * and injects a structured input section into its system prompt.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonSchemaObject } from "../../shared/types.ts";

export const TYPED_INPUT_ENV = "PI_SUBAGENT_TYPED_INPUT";

export interface TypedInputRuntime {
	input: unknown;
	inputPath: string;
}

export interface TypedInputPayload {
	input: unknown;
	schema?: JsonSchemaObject;
}

/**
 * Persist the typed input (and optional schema) to a temp file the child
 * process can read. Returns the runtime handle whose `inputPath` is exported
 * via env to the child.
 */
export function createTypedInputRuntime(input: unknown, schema: JsonSchemaObject | undefined, baseDir?: string): TypedInputRuntime {
	const rootDir = baseDir ?? os.tmpdir();
	fs.mkdirSync(rootDir, { recursive: true });
	const dir = fs.mkdtempSync(path.join(rootDir, "pi-subagent-typed-input-"));
	const inputPath = path.join(dir, "input.json");
	const payload: TypedInputPayload = { input, ...(schema ? { schema } : {}) };
	fs.writeFileSync(inputPath, JSON.stringify(payload), { mode: 0o600 });
	return { input, inputPath };
}

/**
 * Read the typed-input payload written by the parent. Returns undefined when
 * the file is missing or malformed (the child treats a missing typed input as
 * a legacy invocation).
 */
export function readTypedInputPayload(inputPath: string | undefined): TypedInputPayload | undefined {
	if (!inputPath) return undefined;
	if (!fs.existsSync(inputPath)) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(inputPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as TypedInputPayload;
	} catch {
		return undefined;
	}
}

export function cleanupTypedInputRuntime(runtime: TypedInputRuntime | undefined): void {
	if (!runtime) return;
	try {
		fs.rmSync(path.dirname(runtime.inputPath), { recursive: true, force: true });
	} catch {
		// Best-effort temp cleanup.
	}
}
