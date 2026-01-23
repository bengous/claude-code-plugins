#!/usr/bin/env bun
/**
 * Simple test to verify the SDK works.
 * Run: bun _shared/claude-cli/__tests__/test-spawn.ts
 */

import { spawn, withPreset, QUICK_PRESET, VALIDATE_PRESET } from "../index";

console.log("Testing Claude CLI SDK...\n");

// Test 1: Quick one-shot question
console.log("Test 1: Quick one-shot (QUICK_PRESET)");
const result1 = spawn(
  withPreset(QUICK_PRESET, {
    prompt: "Respond with exactly: SDK_TEST_OK",
    timeout: 30000,
  })
);

if (result1.ok) {
  console.log(`  Result: ${result1.result.trim()}`);
  console.log(`  Session: ${result1.sessionId}`);
  console.log(`  Cost: $${result1.totalCostUsd.toFixed(4)}`);
  console.log(`  Duration: ${result1.durationMs}ms`);
  console.log(`  Turns: ${result1.numTurns}`);
  console.log("  Status: PASS\n");
} else {
  console.log(`  Error: ${result1.error}`);
  console.log(`  Exit code: ${result1.exitCode}`);
  console.log("  Status: FAIL\n");
}

// Test 2: With tool restrictions
console.log("Test 2: With tool restrictions (VALIDATE_PRESET)");
const result2 = spawn(
  withPreset(VALIDATE_PRESET, {
    prompt: "What tools do you have access to? List them briefly.",
    timeout: 30000,
  })
);

if (result2.ok) {
  console.log(`  Result: ${result2.result.substring(0, 100)}...`);
  console.log("  Status: PASS\n");
} else {
  console.log(`  Error: ${result2.error}`);
  console.log("  Status: FAIL\n");
}

// Summary
console.log("─────────────────────────────");
const allPassed = result1.ok && result2.ok;
if (allPassed) {
  console.log("All tests passed.");
  process.exit(0);
} else {
  console.log("Some tests failed.");
  process.exit(1);
}
