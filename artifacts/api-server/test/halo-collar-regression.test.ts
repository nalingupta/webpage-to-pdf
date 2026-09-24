import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Runs against the managed API workflow through the shared proxy.
// Requires network access to the public regression URL and pdftotext.
const response = await fetch("http://localhost:80/api/pdf", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: "https://www.halocollar.com/dog-fence-features/virtual-gps/",
    pageSize: "A4", orientation: "portrait",
    hideNotices: true, expandedCapture: true,
  }),
  signal: AbortSignal.timeout(110_000),
});
if (!response.ok) assert.fail(`PDF endpoint returned ${response.status}: ${await response.text()}`);
assert.match(response.headers.get("content-type") || "", /application\/pdf/);
const summary = JSON.parse(response.headers.get("x-expansion-summary") || "null");
assert.ok(summary, "Expansion diagnostics must be returned");
assert.ok(summary.nativeDetailsOpened >= 11, JSON.stringify(summary));
assert.equal(summary.remainingCollapsed, 0, JSON.stringify(summary));
assert.ok(summary.diagnostics.some(
  (item: { label: string; strategy: string }) =>
    item.label.includes("View all 19 specifications") && item.strategy === "hidden panel CSS overridden",
), "The pre-existing hidden specifications must be revealed in print");

const pdf = Buffer.from(await response.arrayBuffer());
assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
const text = execFileSync("pdftotext", ["-layout", "-", "-"], {
  input: pdf, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
}).replace(/\s+/g, " ");
for (const answerEnding of [
  "Dogs stay protected even in remote locations with no internet access whatsoever.",
  "custom polygon shapes with unlimited points are fully supported.",
  "all prevention feedback stops.",
  "each individually paused, edited, or enabled at any time.",
  "keeping training clear and consistent.",
  "introduces boundaries gradually and positively.",
  "and instant recall.",
  "a wide range of temperaments and energy levels.",
  "and they require no physical upkeep.",
  "wider buffer zone around the boundary is recommended.",
  "see Halo Collar 5 vs. SpotOn Fence.",
  "Maximum Fence Area",
  "Within 0.6 meters of true outdoor position",
]) {
  assert.ok(text.includes(answerEnding), `Missing printed content: ${answerEnding}`);
}
process.stdout.write("Halo Collar hosted PDF regression passed: 11 full FAQ answers and hidden specifications.\n");