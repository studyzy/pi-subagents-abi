import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { formatAbiSummary, parseAgentAbiFrontmatter, resolveEffectiveOutputSchema, validateAbiDefinition, validateTypedInputSync, type AgentABI } from "../../src/agents/abi.ts";
import { parseFrontmatter } from "../../src/agents/frontmatter.ts";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { discoverAgents, type AgentConfig } from "../../src/agents/agents.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function writeAgent(filePath: string, body: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

describe("parseAgentAbiFrontmatter", () => {
	it("returns undefined for empty or whitespace-only input", () => {
		assert.equal(parseAgentAbiFrontmatter(undefined, "a"), undefined);
		assert.equal(parseAgentAbiFrontmatter("", "a"), undefined);
		assert.equal(parseAgentAbiFrontmatter("   \n  ", "a"), undefined);
	});

	it("parses a full input+output ABI from YAML block text", () => {
		const raw = [
			"version: \"1\"",
			"input:",
			"  type: object",
			"  required:",
			"    - target",
			"  properties:",
			"    target:",
			"      type: string",
			"output:",
			"  type: object",
			"  properties:",
			"    summary:",
			"      type: string",
		].join("\n");
		const abi = parseAgentAbiFrontmatter(raw, "arch")!;
		assert.equal(abi.version, "1");
		assert.deepEqual(abi.input, { type: "object", required: ["target"], properties: { target: { type: "string" } } });
		assert.deepEqual(abi.output, { type: "object", properties: { summary: { type: "string" } } });
	});

	it("parses an input-only ABI", () => {
		const abi = parseAgentAbiFrontmatter("input:\n  type: object\n", "a")!;
		assert.deepEqual(abi.input, { type: "object" });
		assert.equal(abi.output, undefined);
	});

	it("throws on invalid YAML", () => {
		assert.throws(
			() => parseAgentAbiFrontmatter("input:\n  type: [unclosed", "a"),
			/invalid abi frontmatter/,
		);
	});

	it("throws when abi root is not an object", () => {
		assert.throws(
			() => parseAgentAbiFrontmatter("- item\n- item\n", "a"),
			/invalid abi frontmatter; expected an object/,
		);
	});
});

describe("validateAbiDefinition", () => {
	it("accepts a valid object ABI", () => {
		const abi: AgentABI = {
			version: "1",
			input: { type: "object" },
			output: { type: "object" },
		};
		assert.doesNotThrow(() => validateAbiDefinition(abi, "a"));
	});

	it("accepts an ABI with no input/output", () => {
		assert.doesNotThrow(() => validateAbiDefinition({ version: "1" }, "a"));
	});

	it("throws when abi is an array", () => {
		assert.throws(
			() => validateAbiDefinition([], "a"),
			/invalid abi frontmatter; expected an object/,
		);
	});

	it("throws when abi.input is a non-object (array)", () => {
		assert.throws(
			() => validateAbiDefinition({ input: [] }, "a"),
			/abi\.input must be a JSON Schema object/,
		);
	});

	it("throws when abi.output is a primitive", () => {
		assert.throws(
			() => validateAbiDefinition({ output: "summary" }, "a"),
			/abi\.output must be a JSON Schema object/,
		);
	});

	it("throws when abi.version is not a string", () => {
		assert.throws(
			() => validateAbiDefinition({ version: 2 }, "a"),
			/abi\.version must be a string/,
		);
	});
});

describe("agent discovery ABI integration", () => {
	it("discovers an agent with a full input+output ABI", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-abi-discovery-"));
		tempDirs.push(dir);
		writeAgent(path.join(dir, ".pi", "agents", "architecture-reviewer.md"), `---
name: architecture-reviewer
description: Analyze architecture
abi:
  version: "1"
  input:
    title: ArchitectureReviewRequest
    type: object
    required:
      - target
    properties:
      target:
        type: string
  output:
    title: ArchitectureReviewResult
    type: object
    properties:
      summary:
        type: string
---

Analyze the target.
`);

		const agent = discoverAgents(dir, "project").agents.find((candidate) => candidate.name === "architecture-reviewer");
		assert.ok(agent, "architecture-reviewer should be discovered");
		assert.equal(agent.abi?.version, "1");
		assert.deepEqual(agent.abi?.input, {
			title: "ArchitectureReviewRequest",
			type: "object",
			required: ["target"],
			properties: { target: { type: "string" } },
		});
		assert.deepEqual(agent.abi?.output, {
			title: "ArchitectureReviewResult",
			type: "object",
			properties: { summary: { type: "string" } },
		});
	});

	it("discovers an agent without ABI with abi === undefined", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-abi-noabi-"));
		tempDirs.push(dir);
		writeAgent(path.join(dir, ".pi", "agents", "plain.md"), `---
name: plain
description: No ABI
---

Just work.
`);

		const agent = discoverAgents(dir, "project").agents.find((candidate) => candidate.name === "plain");
		assert.ok(agent, "plain should be discovered");
		assert.equal(agent.abi, undefined);
	});

	it("throws (fail-fast) when abi frontmatter is structurally invalid", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-abi-invalid-"));
		tempDirs.push(dir);
		writeAgent(path.join(dir, ".pi", "agents", "bad.md"), `---
name: bad
description: Bad ABI
abi:
  input: just-a-string
---

Work.
`);

		assert.throws(
			() => discoverAgents(dir, "project"),
			/abi\.input must be a JSON Schema object/,
		);
	});
});

describe("agent ABI serialization round-trip", () => {
	function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
		return {
			name: "arch",
			description: "Analyze architecture",
			systemPrompt: "Analyze.",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/arch.md",
			...overrides,
		};
	}

	it("serializes abi as a nested YAML block", () => {
		const agent = baseAgent({
			abi: {
				version: "1",
				input: { type: "object", required: ["target"], properties: { target: { type: "string" } } },
				output: { type: "object", properties: { summary: { type: "string" } } },
			},
		});

		const serialized = serializeAgent(agent);
		assert.match(serialized, /^abi:\n  version: "1"\n  input:\n    type: object\n    required:\n      - target\n    properties:\n      target:\n        type: string\n  output:\n    type: object\n    properties:\n      summary:\n        type: string$/m);
	});

	it("omits abi block when absent", () => {
		const serialized = serializeAgent(baseAgent());
		assert.doesNotMatch(serialized, /^abi:/m);
	});

	it("round-trips: serialize then re-discover preserves abi fields", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-abi-roundtrip-"));
		tempDirs.push(dir);
		const agent = baseAgent({
			filePath: path.join(dir, ".pi", "agents", "arch.md"),
			abi: {
				version: "1",
				input: { type: "object", required: ["target"], properties: { target: { type: "string" } } },
				output: { type: "object", properties: { summary: { type: "string" } } },
			},
		});

		const serialized = serializeAgent(agent);
		writeAgent(agent.filePath, serialized);

		const rediscovered = discoverAgents(dir, "project").agents.find((candidate) => candidate.name === "arch");
		assert.ok(rediscovered, "arch should be re-discovered");
		assert.deepEqual(rediscovered.abi, agent.abi);
	});
});

describe("resolveEffectiveOutputSchema", () => {
	const callSchema = { type: "object", properties: { a: { type: "string" } } };
	const abiSchema = { type: "object", properties: { b: { type: "string" } } };

	it("prefers per-call outputSchema over agent abi.output", () => {
		const abi: AgentABI = { output: abiSchema };
		assert.equal(resolveEffectiveOutputSchema(callSchema, abi), callSchema);
	});

	it("falls back to agent abi.output when no per-call schema", () => {
		const abi: AgentABI = { output: abiSchema };
		assert.equal(resolveEffectiveOutputSchema(undefined, abi), abiSchema);
	});

	it("returns undefined when neither per-call schema nor abi is present", () => {
		assert.equal(resolveEffectiveOutputSchema(undefined, undefined), undefined);
	});

	it("returns undefined when abi has no output field", () => {
		const abi: AgentABI = { input: { type: "object" } };
		assert.equal(resolveEffectiveOutputSchema(undefined, abi), undefined);
	});
});

describe("formatAbiSummary", () => {
	it("uses schema titles when both are present", () => {
		const abi: AgentABI = {
			input: { title: "ArchitectureReviewRequest", type: "object" },
			output: { title: "ArchitectureReviewResult", type: "object" },
		};
		assert.equal(formatAbiSummary(abi), "[ArchitectureReviewRequest -> ArchitectureReviewResult]");
	});

	it("falls back to object for a schema without a title", () => {
		const abi: AgentABI = {
			input: { type: "object" },
			output: { title: "ReviewResult", type: "object" },
		};
		assert.equal(formatAbiSummary(abi), "[object -> ReviewResult]");
	});

	it("falls back to object when a side is missing entirely", () => {
		const abi: AgentABI = { input: { title: "Request", type: "object" } };
		assert.equal(formatAbiSummary(abi), "[Request -> object]");
	});

	it("returns an empty string when there is no ABI", () => {
		assert.equal(formatAbiSummary(undefined), "");
	});

	it("ignores blank-string titles", () => {
		const abi: AgentABI = {
			input: { title: "  ", type: "object" },
			output: { title: "Result", type: "object" },
		};
		assert.equal(formatAbiSummary(abi), "[object -> Result]");
	});
});

describe("example agent fixture", () => {
	const examplePath = path.join(import.meta.dirname, "../../agents/architecture-reviewer.md");

	it("parses the shipped architecture-reviewer example with a full ABI", () => {
		const content = fs.readFileSync(examplePath, "utf-8");
		const abi = parseAgentAbiFrontmatter(parseFrontmatter(content).frontmatter.abi, "architecture-reviewer");
		assert.ok(abi, "example agent should declare an abi block");
		assert.equal(abi.version, "1");
		assert.equal(abi.input?.title, "ArchitectureReviewRequest");
		assert.deepEqual(abi.input?.required, ["target"]);
		assert.equal(abi.output?.title, "ArchitectureReviewResult");
		assert.deepEqual(abi.output?.required, ["summary", "strengths", "risks", "recommendedActions"]);
	});
});

describe("validateTypedInputSync", () => {
	const schema = {
		type: "object",
		additionalProperties: false,
		required: ["target"],
		properties: {
			target: { type: "string" },
			areas: { type: "array", items: { type: "string", enum: ["architecture", "dependency"] } },
		},
	};

	it("accepts a valid input", () => {
		assert.deepEqual(validateTypedInputSync(schema, { target: ".", areas: ["architecture"] }), { status: "valid" });
	});

	it("rejects a missing required field with a path in the message", () => {
		const result = validateTypedInputSync(schema, { areas: [] });
		assert.equal(result.status, "invalid");
		assert.match(result.message, /target/);
	});

	it("rejects a wrong type", () => {
		const result = validateTypedInputSync(schema, { target: 42 });
		assert.equal(result.status, "invalid");
		assert.match(result.message, /target/);
	});

	it("rejects an out-of-enum value", () => {
		const result = validateTypedInputSync(schema, { target: ".", areas: ["database"] });
		assert.equal(result.status, "invalid");
		assert.match(result.message, /areas/);
	});

	it("rejects an extra property when additionalProperties is false", () => {
		const result = validateTypedInputSync(schema, { target: ".", extra: true });
		assert.equal(result.status, "invalid");
	});

	it("returns invalid with a clear message for a non-object root schema", () => {
		const result = validateTypedInputSync("not-a-schema" as never, {});
		assert.equal(result.status, "invalid");
		assert.match(result.message, /invalid input schema/);
	});
});
