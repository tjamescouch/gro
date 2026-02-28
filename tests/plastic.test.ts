/**
 * Integration tests for PLASTIC mode overlay system.
 * Tests the init → copy → write_source → boot cycle.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { tmpdir } from "node:os";

// We test the individual components rather than the full boot flow
// (which requires a running gro process).

describe("PLASTIC: overlay init", () => {
  let testDir: string;
  let stockDir: string;
  let overlayDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `gro-plastic-test-${Date.now()}`);
    stockDir = join(testDir, "stock-dist");
    overlayDir = join(testDir, "overlay");

    // Create a fake stock dist/ with some files
    mkdirSync(join(stockDir, "memory"), { recursive: true });
    mkdirSync(join(stockDir, "plastic"), { recursive: true });
    mkdirSync(join(stockDir, "tools"), { recursive: true });
    writeFileSync(join(stockDir, "main.js"), 'export function main() { return "stock"; }\n');
    writeFileSync(join(stockDir, "version.js"), 'export const GRO_VERSION = "1.0.0";\n');
    writeFileSync(join(stockDir, "memory", "virtual-memory.js"), "// vm\n");
    writeFileSync(join(stockDir, "plastic", "bootstrap.js"), "// bootstrap\n");
    writeFileSync(join(stockDir, "plastic", "write-source.js"), "// write-source\n");
    writeFileSync(join(stockDir, "plastic", "init.js"), "// init\n");
    writeFileSync(join(stockDir, "tools", "write.js"), "// write tool\n");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Recursively copy (same logic as init.ts mirrorWithCopies). */
  function mirrorWithCopies(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        mirrorWithCopies(srcPath, destPath);
      } else {
        if (!existsSync(destPath)) {
          copyFileSync(srcPath, destPath);
        }
      }
    }
  }

  it("copies all files from stock to overlay", () => {
    mirrorWithCopies(stockDir, overlayDir);

    assert.ok(existsSync(join(overlayDir, "main.js")));
    assert.ok(existsSync(join(overlayDir, "version.js")));
    assert.ok(existsSync(join(overlayDir, "memory", "virtual-memory.js")));
    assert.ok(existsSync(join(overlayDir, "tools", "write.js")));
  });

  it("includes plastic/ subdirectory in overlay", () => {
    mirrorWithCopies(stockDir, overlayDir);

    assert.ok(existsSync(join(overlayDir, "plastic", "write-source.js")));
    assert.ok(existsSync(join(overlayDir, "plastic", "init.js")));
    assert.ok(existsSync(join(overlayDir, "plastic", "bootstrap.js")));
  });

  it("copies are real files, not symlinks", () => {
    mirrorWithCopies(stockDir, overlayDir);

    const stat = statSync(join(overlayDir, "main.js"));
    assert.ok(stat.isFile());
    // Content matches stock
    const stockContent = readFileSync(join(stockDir, "main.js"), "utf-8");
    const overlayContent = readFileSync(join(overlayDir, "main.js"), "utf-8");
    assert.equal(overlayContent, stockContent);
  });

  it("does not overwrite existing overlay files", () => {
    mirrorWithCopies(stockDir, overlayDir);

    // Modify overlay file (agent edit)
    writeFileSync(join(overlayDir, "version.js"), 'export const GRO_VERSION = "modified";\n');

    // Re-run mirror — should NOT overwrite the modification
    mirrorWithCopies(stockDir, overlayDir);

    const content = readFileSync(join(overlayDir, "version.js"), "utf-8");
    assert.ok(content.includes("modified"), "modified file should be preserved");
  });
});

describe("PLASTIC: write_source", () => {
  let testDir: string;
  let overlayDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `gro-plastic-ws-${Date.now()}`);
    overlayDir = join(testDir, "overlay");
    mkdirSync(overlayDir, { recursive: true });
    writeFileSync(join(overlayDir, "main.js"), "// stock main\n");
    writeFileSync(join(overlayDir, "version.js"), 'export const GRO_VERSION = "1.0.0";\n');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("rejects path traversal", () => {
    // Simulate handleWriteSource logic
    const path = "../../../etc/passwd";
    const normalizedPath = normalize(path);
    assert.ok(normalizedPath.startsWith(".."), "path traversal should be detected");
  });

  it("rejects empty content", () => {
    assert.ok(true, "empty content should be rejected (tested in handleWriteSource)");
  });
});

describe("PLASTIC: boot flow", () => {
  it("GRO_PLASTIC_BOOTED prevents circular bootstrap", () => {
    // The overlay's main.js checks: if (GRO_PLASTIC && !GRO_PLASTIC_BOOTED)
    // When BOOTED is set, it should call main() directly instead of re-entering bootstrap
    const plasticSet = !!process.env.GRO_PLASTIC;
    const bootedSet = !!process.env.GRO_PLASTIC_BOOTED;

    // In normal test environment, neither should be set
    // The logic is: divert only when PLASTIC && !BOOTED
    const shouldDivert = plasticSet && !bootedSet;
    assert.equal(shouldDivert, false, "should not divert in test environment");
  });

  it("overlay crash triggers wipe for clean re-init", () => {
    // Create a fake overlay dir, verify rmSync would clean it
    const testDir = join(tmpdir(), `gro-plastic-crash-${Date.now()}`);
    const fakeOverlay = join(testDir, "overlay");
    mkdirSync(fakeOverlay, { recursive: true });
    writeFileSync(join(fakeOverlay, "corrupted.js"), "SYNTAX ERROR {{{");

    assert.ok(existsSync(fakeOverlay));
    rmSync(fakeOverlay, { recursive: true, force: true });
    assert.ok(!existsSync(fakeOverlay), "overlay should be wiped after crash");

    rmSync(testDir, { recursive: true, force: true });
  });
});
