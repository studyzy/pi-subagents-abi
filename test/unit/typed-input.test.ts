import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { cleanupTypedInputRuntime, createTypedInputRuntime, readTypedInputPayload, TYPED_INPUT_ENV } from "../../src/runs/shared/typed-input.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-typed-input-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("typed-input runtime", () => {
	it("exposes the typed-input env var name", () => {
		assert.equal(TYPED_INPUT_ENV, "PI_SUBAGENT_TYPED_INPUT");
	});

	it("persists input and schema to a temp file and reads them back", () => {
		const schema = { type: "object", properties: { target: { type: "string" } } };
		const runtime = createTypedInputRuntime({ target: "." }, schema, tempDir());

		assert.deepEqual(runtime.input, { target: "." });
		assert.ok(fs.existsSync(runtime.inputPath), "input.json should be written");
		assert.equal(runtime.inputPath.endsWith("input.json"), true);

		const payload = readTypedInputPayload(runtime.inputPath);
		assert.deepEqual(payload, { input: { target: "." }, schema });
	});

	it("reads back input without a schema when schema is omitted", () => {
		const runtime = createTypedInputRuntime({ target: "." }, undefined, tempDir());
		const payload = readTypedInputPayload(runtime.inputPath);
		assert.deepEqual(payload, { input: { target: "." } });
	});

	it("returns undefined for a missing file", () => {
		assert.equal(readTypedInputPayload(path.join(tempDir(), "does-not-exist.json")), undefined);
	});

	it("returns undefined for malformed JSON", () => {
		const dir = tempDir();
		const badPath = path.join(dir, "bad.json");
		fs.writeFileSync(badPath, "{ not json", "utf-8");
		assert.equal(readTypedInputPayload(badPath), undefined);
	});

	it("cleans up the temp directory", () => {
		const runtime = createTypedInputRuntime({ a: 1 }, undefined, tempDir());
		const dir = path.dirname(runtime.inputPath);
		assert.ok(fs.existsSync(dir));
		cleanupTypedInputRuntime(runtime);
		assert.equal(fs.existsSync(dir), false);
	});

	it("cleanup is a no-op for undefined runtime", () => {
		assert.doesNotThrow(() => cleanupTypedInputRuntime(undefined));
	});
});
