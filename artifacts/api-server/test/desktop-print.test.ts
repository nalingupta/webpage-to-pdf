import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { PDFDocument } from "pdf-lib";
import { printDesktopPage } from "../src/lib/desktop-print";
import { optimizePdf } from "../src/lib/pdf-optimizer";

assert.match(
  execFileSync("fc-match", ["-f", "%{family}", "emoji"], { encoding: "utf8" }),
  /Noto Color Emoji/,
  "Chromium needs an emoji font to print pictograms instead of empty boxes",
);

const browser = await chromium.launch({
  executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 820 } });
  await page.emulateMedia({ media: "screen" });
  await page.setContent(`
    <style>
      body { margin: 0; }
      .cards { display: grid; grid-template-columns: repeat(3, 1fr); }
      @media (max-width: 900px) { .cards { grid-template-columns: 1fr; } }
      .cards > div { height: 100px; }
    </style>
    <div class="cards">
      <div><a href="https://example.com/linked">FIRST CARD</a> 🏕️</div>
      <div>SECOND CARD</div>
      <div>THIRD CARD</div>
    </div>
  `);
  const output = await printDesktopPage(page, "A4", false, 1080);
  const pdf = await PDFDocument.load(output);
  assert.equal(pdf.getPage(0).getWidth().toFixed(1), (210 * 72 / 25.4).toFixed(1));
  assert.equal(pdf.getPage(0).getHeight().toFixed(1), (297 * 72 / 25.4).toFixed(1));
  assert.ok(pdf.getPage(0).node.Annots()?.size(), "Desktop links must survive paper resizing");

  const xml = execFileSync("pdftotext", ["-bbox", "-", "-"], {
    input: output, encoding: "utf8",
  });
  const cardPositions = ["FIRST", "SECOND", "THIRD"].map((word) => {
    const match = xml.match(new RegExp(`<word xMin="([^"]+)" yMin="([^"]+)"[^>]*>${word}</word>`));
    assert.ok(match, `Missing ${word} in the printable PDF`);
    return { x: Number(match[1]), y: Number(match[2]) };
  });
  assert.ok(cardPositions[0].x < cardPositions[1].x &&
    cardPositions[1].x < cardPositions[2].x, "Desktop cards must remain in three columns");
  assert.ok(Math.max(...cardPositions.map(({ y }) => y)) -
    Math.min(...cardPositions.map(({ y }) => y)) < 3, "Desktop cards must share the same row");

  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1400;
    canvas.height = 1400;
    canvas.style.width = "800px";
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 12345;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[index] = seed & 255;
      pixels.data[index + 1] = (seed >>> 8) & 255;
      pixels.data[index + 2] = (seed >>> 16) & 255;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    document.body.appendChild(canvas);
  });
  const imageHeavyPdf = await printDesktopPage(page, "A4", false, 1080);
  const optimized = await optimizePdf(imageHeavyPdf);
  assert.ok(optimized.length < imageHeavyPdf.length * 0.7,
    `Low-resolution optimization should shrink image-heavy PDFs (${imageHeavyPdf.length} -> ${optimized.length})`);
  assert.match(execFileSync("pdftotext", ["-", "-"], { input: optimized, encoding: "utf8" }), /FIRST CARD/,
    "PDF text must remain selectable after optimization");
  assert.ok((await PDFDocument.load(optimized)).getPage(0).node.Annots()?.size(),
    "PDF hyperlinks must remain after optimization");
} finally {
  await browser.close();
}
process.stdout.write("Desktop print layout test passed\n");