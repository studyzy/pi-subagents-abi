/**
 * Agent ABI (Application Binary Interface) model and frontmatter parsing.
 *
 * An agent may declare a typed input/output contract via the `abi` frontmatter
 * block. Both `input` and `output` are JSON Schema objects and are optional,
 * allowing incremental adoption.
 */

import { Compile } from "typebox/compile";
import { parse as parseYaml } from "yaml";
import type { JsonSchemaObject } from "../shared/types.ts";

interface CompiledJsonSchema {
	Check(value: unknown): boolean;
	Errors(value: unknown): Iterable<{ instancePath?: string; message?: string }>;
}

type CompiledJsonSchemaConstructor = (schema: unknown) => CompiledJsonSchema;

export interface AgentABI {
	input?: JsonSchemaObject;
	output?: JsonSchemaObject;
	version?: string;
	/** Parent-level structured output repair attempts after child-side self-correction is exhausted (default 2). */
	maxRetries?: number;
}

/** Maximum parent-level repair attempts for a malformed structured output (industry standard validate-repair-retry). */
export const DEFAULT_OUTPUT_REPAIR_MAX_RETRIES = 2;

/**
 * Resolve the repair budget for an agent. An agent that declares an ABI gets
 * the default budget unless it overrides it; agents without an ABI never
 * engage parent-level output repair (their per-call `outputSchema` behavior is
 * unchanged).
 */
export function resolveOutputRepairMaxRetries(abi: AgentABI | undefined): number {
	if (!abi) return 0;
	return abi.maxRetries ?? DEFAULT_OUTPUT_REPAIR_MAX_RETRIES;
}

function assertJsonSchemaObject(value: unknown, label: string): asserts value is JsonSchemaObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be a JSON Schema object.`);
	}
}

/**
 * Validate the structure of an ABI definition itself (sanity check only — see
 * docs/pi-agent-abi-development-plan.md §6). The `typebox/compile` validator
 * does not reject malformed schemas such as `type: "unknown_type"`, so this
 * only enforces object shape; deeper schema errors surface at runtime
 * validation, matching the existing `outputSchema` behavior.
 */
export function validateAbiDefinition(abi: unknown, agentName: string): asserts abi is AgentABI {
	if (!abi || typeof abi !== "object" || Array.isArray(abi)) {
		throw new Error(`Agent '${agentName}' has invalid abi frontmatter; expected an object.`);
	}
	const candidate = abi as Record<string, unknown>;
	if (candidate.input !== undefined) {
		assertJsonSchemaObject(candidate.input, `Agent '${agentName}' abi.input`);
	}
	if (candidate.output !== undefined) {
		assertJsonSchemaObject(candidate.output, `Agent '${agentName}' abi.output`);
	}
	if (candidate.version !== undefined && typeof candidate.version !== "string") {
		throw new Error(`Agent '${agentName}' abi.version must be a string.`);
	}
	if (candidate.maxRetries !== undefined) {
		if (typeof candidate.maxRetries !== "number" || !Number.isInteger(candidate.maxRetries) || candidate.maxRetries < 0) {
			throw new Error(`Agent '${agentName}' abi.maxRetries must be a non-negative integer.`);
		}
	}
}

/**
 * Parse the raw `abi` frontmatter block (a YAML string preserved by the
 * hand-written frontmatter parser) into an {@link AgentABI}.
 *
 * Follows the same two-stage pattern as `runner`/`permissions`: the frontmatter
 * parser hands over the raw block string, and `parseYaml` resolves the nested
 * object.
 */
export function parseAgentAbiFrontmatter(raw: string | undefined, agentName: string): AgentABI | undefined {
	if (raw === undefined || !raw.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (error) {
		throw new Error(`Agent '${agentName}' has invalid abi frontmatter: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	validateAbiDefinition(parsed, agentName);
	return parsed as AgentABI;
}

/**
 * Resolve the effective output schema for a single-agent invocation.
 *
 * A per-call `outputSchema` wins; otherwise the agent's declared `abi.output`
 * is used. Returns `undefined` when neither is present (legacy free-text
 * output).
 */
export function resolveEffectiveOutputSchema(callOutputSchema: JsonSchemaObject | undefined, abi: AgentABI | undefined): JsonSchemaObject | undefined {
	return callOutputSchema ?? abi?.output;
}

function schemaDisplayTitle(schema: JsonSchemaObject | undefined): string {
	const title = schema?.title;
	return typeof title === "string" && title.trim() ? title : "object";
}

/**
 * One-line ABI summary for discovery output (`handleList`), e.g.
 * `[ArchitectureReviewRequest -> ArchitectureReviewResult]`. The `title` of
 * each schema is used when present, otherwise `object`. Returns an empty
 * string when the agent declares no ABI so legacy list lines stay unchanged.
 */
export function formatAbiSummary(abi: AgentABI | undefined): string {
	if (!abi) return "";
	return `[${schemaDisplayTitle(abi.input)} -> ${schemaDisplayTitle(abi.output)}]`;
}

/**
 * Synchronously validate a typed input value against an input schema.
 *
 * Uses a static `typebox/compile` import (safe in the parent extension process,
 * where typebox is a direct dependency) so the check can run inline in both
 * synchronous and asynchronous execution paths.
 *
 * Returns the same shape as `validateStructuredOutputValue` for consistency:
 * `{ status: "valid" }` or `{ status: "invalid", message }` with `path: msg`
 * entries.
 */
export function validateTypedInputSync(schema: JsonSchemaObject, value: unknown): { status: "valid" } | { status: "invalid"; message: string } {
	let validator: CompiledJsonSchema;
	try {
		validator = (Compile as CompiledJsonSchemaConstructor)(schema);
	} catch (error) {
		return { status: "invalid", message: `invalid input schema: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (validator.Check(value)) return { status: "valid" };
	const errors = [...validator.Errors(value)]
		.slice(0, 8)
		.map((error) => {
			const pathText = error.instancePath ? error.instancePath.replace(/^\//, "").replace(/\//g, ".") : "root";
			return `${pathText}: ${error.message}`;
		});
	return { status: "invalid", message: errors.join("; ") || "schema validation failed" };
}
