import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveOutputRepairMaxRetries, validateAbiDefinition } from "../../src/agents/abi.ts";
import { buildStructuredOutputRepairPrompt, summarizeOutputSchema } from "../../src/runs/shared/structured-output.ts";

const schema = {
	title: "ArchitectureReviewResult",
	type: "object",
	required: ["summary"],
	properties: {
		summary: { type: "string" },
		verdict: { type: "string", enum: ["ok", "warn", "block"] },
	},
};

describe("summarizeOutputSchema", () => {
	it("summarizes title, type, required and properties", () => {
		const summary = summarizeOutputSchema(schema);
		assert.match(summary, /title: ArchitectureReviewResult/);
		assert.match(summary, /type: object/);
		assert.match(summary, /required: summary/);
		assert.match(summary, /properties: summary, verdict/);
	});

	it("omits absent keywords", () => {
		const summary = summarizeOutputSchema({ type: "object" });
		assert.equal(summary, "type: object");
	});

	it("falls back to a truncated JSON for opaque schemas", () => {
		const opaque = { "x-custom": "a".repeat(500) };
		const summary = summarizeOutputSchema(opaque);
		assert.ok(summary.endsWith("…"));
		assert.ok(summary.length < 450);
	});
});

describe("buildStructuredOutputRepairPrompt", () => {
	it("includes structured validation errors with path localization", () => {
		const prompt = buildStructuredOutputRepairPrompt({
			agentName: "arch",
			validationError: "summary: must be string; verdict: must be equal to one of ok, warn, block",
			schema,
			attempt: 1,
			maxRetries: 2,
		});
		assert.match(prompt, /Validation errors:/);
		assert.match(prompt, /- summary: must be string/);
		assert.match(prompt, /- verdict: must be equal to one of ok, warn, block/);
	});

	it("includes the expected output shape summary and repair instruction", () => {
		const prompt = buildStructuredOutputRepairPrompt({
			agentName: "arch",
			validationError: "summary: must be string",
			schema,
			attempt: 1,
			maxRetries: 2,
		});
		assert.match(prompt, /Expected output shape:/);
		assert.match(prompt, /title: ArchitectureReviewResult/);
		assert.match(prompt, /Do NOT re-run the original task/);
		assert.match(prompt, /attempt 1 of 2/);
		assert.match(prompt, /structured_output/);
	});

	it("does not leak the original task when a session is reused", () => {
		const prompt = buildStructuredOutputRepairPrompt({
			agentName: "arch",
			validationError: "summary: must be string",
			schema,
			attempt: 1,
			maxRetries: 2,
		});
		assert.doesNotMatch(prompt, /analyze the monorepo/i);
	});

	it("includes the original task context when no session is reused", () => {
		const prompt = buildStructuredOutputRepairPrompt({
			agentName: "arch",
			validationError: "summary: must be string",
			schema,
			attempt: 1,
			maxRetries: 2,
			originalTask: "Analyze the monorepo architecture.",
		});
		assert.match(prompt, /Analyze the monorepo architecture\./);
		assert.match(prompt, /for reference; do not re-run it/);
	});

	it("tolerates an empty validation error", () => {
		const prompt = buildStructuredOutputRepairPrompt({
			agentName: "arch",
			validationError: "",
			schema,
			attempt: 1,
			maxRetries: 2,
		});
		assert.doesNotMatch(prompt, /^Validation errors:\n\n$/m);
		assert.match(prompt, /Expected output shape:/);
	});
});

describe("abi.maxRetries validation", () => {
	it("accepts a non-negative integer", () => {
		assert.doesNotThrow(() => validateAbiDefinition({ maxRetries: 2 }, "a"));
		assert.doesNotThrow(() => validateAbiDefinition({ maxRetries: 0 }, "a"));
	});

	it("rejects a negative value", () => {
		assert.throws(
			() => validateAbiDefinition({ maxRetries: -1 }, "a"),
			/abi\.maxRetries must be a non-negative integer/,
		);
	});

	it("rejects a fractional value", () => {
		assert.throws(
			() => validateAbiDefinition({ maxRetries: 1.5 }, "a"),
			/abi\.maxRetries must be a non-negative integer/,
		);
	});

	it("rejects a non-number", () => {
		assert.throws(
			() => validateAbiDefinition({ maxRetries: "2" }, "a"),
			/abi\.maxRetries must be a non-negative integer/,
		);
	});
});

describe("resolveOutputRepairMaxRetries", () => {
	it("returns 0 for agents without an ABI", () => {
		assert.equal(resolveOutputRepairMaxRetries(undefined), 0);
	});

	it("defaults to 2 for agents that declare an ABI without maxRetries", () => {
		assert.equal(resolveOutputRepairMaxRetries({ output: { type: "object" } }), 2);
	});

	it("honors an explicit maxRetries", () => {
		assert.equal(resolveOutputRepairMaxRetries({ maxRetries: 5 }), 5);
		assert.equal(resolveOutputRepairMaxRetries({ maxRetries: 0 }), 0);
	});
});
