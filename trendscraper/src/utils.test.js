import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cleanup } from "./utils.js";

describe("cleanup utility", () => {
  test("should delete an existing directory and its contents", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-test-"));
    const filePath = path.join(tmpDir, "test-file.txt");
    fs.writeFileSync(filePath, "test content");

    assert.strictEqual(fs.existsSync(tmpDir), true);
    assert.strictEqual(fs.existsSync(filePath), true);

    cleanup(tmpDir);

    assert.strictEqual(fs.existsSync(tmpDir), false);
    assert.strictEqual(fs.existsSync(filePath), false);
  });

  test("should handle non-existent directory without error", () => {
    const nonExistentDir = path.join(os.tmpdir(), `non-existent-${Date.now()}`);

    assert.strictEqual(fs.existsSync(nonExistentDir), false);

    // Should not throw
    cleanup(nonExistentDir);

    assert.strictEqual(fs.existsSync(nonExistentDir), false);
  });

  test("should delete nested directories recursively", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-nested-test-"));
    const nestedDir = path.join(tmpDir, "nested");
    fs.mkdirSync(nestedDir);
    const filePath = path.join(nestedDir, "test-file.txt");
    fs.writeFileSync(filePath, "test content");

    assert.strictEqual(fs.existsSync(filePath), true);

    cleanup(tmpDir);

    assert.strictEqual(fs.existsSync(tmpDir), false);
  });
});
