import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";
import type { JsonSchemaObject } from "../../shared/types.ts";

export const STRUCTURED_OUTPUT_SCHEMA_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA";
export const STRUCTURED_OUTPUT_CAPTURE_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE";
export const MISSING_STRUCTURED_OUTPUT_CALL_ERROR = "Missing structured_output call; this step has outputSchema and must finish by calling structured_output.";

export interface StructuredOutputRuntime {
	schema: JsonSchemaObject;
	schemaPath: string;
	outputPath: string;
}

const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const SCHEMA_SINGLE_KEYWORDS = ["additionalItems", "additionalProperties", "contains", "not", "propertyNames", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties", "contentSchema"] as const;
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

function rewriteLocalJsonPointerRefs(schema: unknown, pointerPrefix: string, inheritsWrapperResource = true): unknown {
	if (typeof schema === "boolean" || !schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const source = schema as Record<string, unknown>;
	const rewritten: Record<string, unknown> = { ...source };
	const sharesWrapperResource = inheritsWrapperResource && typeof source.$id !== "string";
	if (sharesWrapperResource) {
		for (const keyword of ["$ref", "$dynamicRef", "$recursiveRef"] as const) {
			const ref = source[keyword];
			if (ref === "#") rewritten[keyword] = pointerPrefix;
			else if (typeof ref === "string" && ref.startsWith("#/")) rewritten[keyword] = `${pointerPrefix}${ref.slice(1)}`;
		}
	}
	for (const keyword of SCHEMA_MAP_KEYWORDS) {
		const entries = source[keyword];
		if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
		rewritten[keyword] = Object.fromEntries(Object.entries(entries).map(([name, nested]) => [
			name,
			rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
		]));
	}
	const items = source.items;
	if (Array.isArray(items)) rewritten.items = items.map((nested) => rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource));
	else if (items !== undefined) rewritten.items = rewriteLocalJsonPointerRefs(items, pointerPrefix, sharesWrapperResource);
	for (const keyword of SCHEMA_SINGLE_KEYWORDS) {
		if (source[keyword] !== undefined) rewritten[keyword] = rewriteLocalJsonPointerRefs(source[keyword], pointerPrefix, sharesWrapperResource);
	}
	for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
		if (Array.isArray(source[keyword])) rewritten[keyword] = source[keyword].map((nested) => rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource));
	}
	const dependencies = source.dependencies;
	if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
		rewritten.dependencies = Object.fromEntries(Object.entries(dependencies).map(([name, nested]) => [
			name,
			Array.isArray(nested) ? nested : rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
		]));
	}
	return rewritten;
}

export function createStructuredOutputToolParameters(schema: JsonSchemaObject): JsonSchemaObject {
	return {
		type: "object",
		properties: { value: rewriteLocalJsonPointerRefs(schema, "#/properties/value") },
		required: ["value"],
		additionalProperties: false,
	};
}

interface CompiledJsonSchema {
	Check(value: unknown): boolean;
	Errors(value: unknown): Iterable<{ instancePath?: string; message?: string }>;
}

type CompileJsonSchema = (schema: unknown) => CompiledJsonSchema;

let cachedCompile: Promise<CompileJsonSchema> | undefined;

export async function resolveCompileFromPackageRoot(packageRoot: string): Promise<CompileJsonSchema | undefined> {
	const requireFromRoot = createRequire(path.join(packageRoot, "package.json"));
	const resolved = requireFromRoot.resolve("typebox/compile");
	const mod = (await import(pathToFileURL(resolved).href)) as { Compile?: unknown };
	return typeof mod.Compile === "function" ? (mod.Compile as CompileJsonSchema) : undefined;
}

async function importCompile(): Promise<CompileJsonSchema> {
	const failures: string[] = [];
	try {
		const mod = (await import("typebox/compile")) as { Compile?: unknown };
		if (typeof mod.Compile === "function") return mod.Compile as CompileJsonSchema;
		failures.push("typebox/compile did not export a Compile function");
	} catch (error) {
		failures.push(`direct import failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	if (packageRoot) {
		try {
			const compile = await resolveCompileFromPackageRoot(packageRoot);
			if (compile) return compile;
			failures.push("Pi package root typebox/compile did not export a Compile function");
		} catch (error) {
			failures.push(`Pi package root import failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		failures.push(`${PI_CODING_AGENT_PACKAGE_ROOT_ENV} is not set`);
	}
	throw new Error(`Cannot load typebox/compile for structured output validation (${failures.join("; ")})`);
}

function loadCompile(): Promise<CompileJsonSchema> {
	if (!cachedCompile) {
		cachedCompile = importCompile().catch((error) => {
			cachedCompile = undefined;
			throw error;
		});
	}
	return cachedCompile;
}

export function assertJsonSchemaObject(schema: unknown, label = "outputSchema"): asserts schema is JsonSchemaObject {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		throw new Error(`${label} must be a JSON Schema object.`);
	}
}

export function createStructuredOutputRuntime(schema: JsonSchemaObject, baseDir?: string): StructuredOutputRuntime {
	assertJsonSchemaObject(schema);
	const rootDir = baseDir ?? os.tmpdir();
	fs.mkdirSync(rootDir, { recursive: true });
	const dir = fs.mkdtempSync(path.join(rootDir, "pi-subagent-structured-"));
	const schemaPath = path.join(dir, "schema.json");
	const outputPath = path.join(dir, "output.json");
	fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
	return { schema, schemaPath, outputPath };
}

export async function validateStructuredOutputValue(schema: JsonSchemaObject, value: unknown): Promise<{ status: "valid" } | { status: "invalid"; message: string }> {
	const compile = await loadCompile();
	let validator: CompiledJsonSchema;
	try {
		validator = compile(schema);
	} catch (error) {
		return { status: "invalid", message: `invalid outputSchema: ${error instanceof Error ? error.message : String(error)}` };
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

export async function readStructuredOutput(runtime: StructuredOutputRuntime): Promise<{ value?: unknown; error?: string }> {
	if (!fs.existsSync(runtime.outputPath)) {
		return { error: MISSING_STRUCTURED_OUTPUT_CALL_ERROR };
	}
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(runtime.outputPath, "utf-8"));
	} catch (error) {
		return { error: `Failed to read structured output: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		const validation = await validateStructuredOutputValue(runtime.schema, value);
		if (validation.status === "invalid") return { error: `Structured output validation failed: ${validation.message}` };
	} catch (error) {
		return { error: `Failed to validate structured output: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { value };
}

export function cleanupStructuredOutputRuntime(runtime: StructuredOutputRuntime | undefined): void {
	if (!runtime) return;
	try {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	} catch {
		// Best-effort temp cleanup.
	}
}

/**
 * Compact, token-friendly summary of a JSON Schema's shape. Includes the top
 * levels of structure (title/type/required/properties) instead of the full
 * schema, since the child already receives the full schema via the
 * `structured_output` tool definition.
 */
export function summarizeOutputSchema(schema: JsonSchemaObject): string {
	const title = typeof schema.title === "string" ? schema.title : undefined;
	const type = Array.isArray(schema.type) ? schema.type.join("|") : typeof schema.type === "string" ? schema.type : undefined;
	const required = Array.isArray(schema.required) && schema.required.length > 0 ? schema.required : undefined;
	let properties: string[] | undefined;
	if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
		const keys = Object.keys(schema.properties);
		if (keys.length > 0) properties = keys.length > 12 ? [...keys.slice(0, 12), "…"] : keys;
	}
	const parts: string[] = [];
	if (title) parts.push(`title: ${title}`);
	if (type) parts.push(`type: ${type}`);
	if (required) parts.push(`required: ${required.join(", ")}`);
	if (properties?.length) parts.push(`properties: ${properties.join(", ")}`);
	if (parts.length === 0) {
		const json = JSON.stringify(schema);
		return json.length > 400 ? `${json.slice(0, 400)}…` : json;
	}
	return parts.join("; ");
}

export interface StructuredOutputRepairPromptInput {
	agentName: string;
	/** The structured output validation error (e.g. `path: msg; path: msg`). */
	validationError: string;
	schema: JsonSchemaObject;
	/** 1-based repair attempt index. */
	attempt: number;
	/** Total allowed repair attempts. */
	maxRetries: number;
	/**
	 * Original task text. Included only when the child cannot recover the
	 * context from a reused session; when a session is reused this must stay
	 * omitted so the model only repairs the output instead of re-running.
	 */
	originalTask?: string;
}

/**
 * Build the natural-language repair prompt for parent-level output repair.
 *
 * Instructs the child to fix only the structured output — not to re-run the
 * original task or make further changes. The structured error list gives the
 * model precise `path: message` localization; the schema summary keeps tokens
 * bounded.
 */
export function buildStructuredOutputRepairPrompt(input: StructuredOutputRepairPromptInput): string {
	const lines = [
		"Your previous response did not pass structured output validation.",
		"",
		"Validation errors:",
		...(input.validationError
			.split("; ")
			.map((entry) => entry.trim())
			.filter(Boolean)
			.map((entry) => `- ${entry}`)),
		"",
		"Expected output shape:",
		summarizeOutputSchema(input.schema),
		"",
		`Do NOT re-run the original task and do not make any further file or tool changes. Call the structured_output tool again with a corrected value that satisfies the schema above (attempt ${input.attempt} of ${input.maxRetries}).`,
	];
	if (input.originalTask) {
		lines.unshift(
			`The task context (for reference; do not re-run it):`,
			input.originalTask,
			"",
		);
	}
	return lines.join("\n");
}
