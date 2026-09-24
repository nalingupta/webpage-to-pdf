import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { PDFDocument, PDFString } from "pdf-lib";
import { chromium } from "playwright-core";

const port = 4174;
const frontendUrl = `http://127.0.0.1:${port}`;
const validSummary = {
  detected: 4,
  opened: 3,
  skipped: 1,
  nativeDetailsOpened: 1,
  disclosuresOpened: 2,
  showMoreActivated: 0,
  passesCompleted: 2,
  remainingCollapsed: 1,
  carousel: { detected: 1, captured: 2, skipped: 0 },
  diagnostics: [
    { label: "FAQ section", strategy: "clicked normally" as const },
    { label: "Native details", strategy: "details forced open" as const },
  ],
};

async function waitForFrontend() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(frontendUrl);
      if (response.ok) return;
    } catch {
      // The Vite process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the webpage-to-PDF frontend.");
}

const frontend: ChildProcess = spawn(
  "pnpm",
  ["--filter", "@workspace/webpage-to-pdf", "run", "dev"],
  {
    cwd: new URL("../../..", import.meta.url),
    env: { ...process.env, PORT: String(port), BASE_PATH: "/", NODE_ENV: "test" },
    stdio: "ignore",
  },
);

try {
  await waitForFrontend();
  const browser = await chromium.launch({
    executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const pdfDocument = await PDFDocument.create();
    const expectedPages = 3;
    const pdfPage = pdfDocument.addPage([612, 792]);
    pdfPage.drawText("Select this PDF text", { x: 72, y: 700, size: 22 });
    const linkAnnotation = pdfDocument.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [72, 590, 300, 620],
      Border: [0, 0, 0],
      A: { S: "URI", URI: PDFString.of("https://example.com/linked") },
    });
    pdfPage.node.addAnnot(pdfDocument.context.register(linkAnnotation));
    for (let pageNumber = 2; pageNumber <= expectedPages; pageNumber += 1) {
      const laterPage = pdfDocument.addPage([612, 792]);
      laterPage.drawText(`Document content on page ${pageNumber}`, { x: 72, y: 700, size: 22 });
    }
    const pdfBytes = Buffer.from(await pdfDocument.save());
    const browserErrors: string[] = [];
    let workerResponses = 0;
    page.on("pageerror", (error) => browserErrors.push(`Page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`Console error: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      if (/pdf\.worker/i.test(request.url())) {
        browserErrors.push(`PDF.js worker request failed: ${request.failure()?.errorText}`);
      }
    });
    page.on("response", (response) => {
      if (/pdf\.worker/i.test(response.url())) {
        workerResponses += 1;
        if (!response.ok()) browserErrors.push(`PDF.js worker returned HTTP ${response.status()}`);
      }
    });
    let summaryHeader: string | undefined;

    await page.route("**/api/pdf/progress/**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ stage: "starting", message: "Preparing PDF capture…" }),
    }));
    await page.route("**/api/pdf", (route) => route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="fixture.example.pdf"',
        ...(summaryHeader ? { "X-Expansion-Summary": summaryHeader } : {}),
      },
      body: pdfBytes,
    }));

    await page.goto(frontendUrl);
    const urlInput = page.getByPlaceholder("https://en.wikipedia.org/wiki/Typography");
    const preview = page.getByLabel("Generated PDF");
    const downloadButton = page.getByTestId("button-download-pdf");
    assert.equal(await downloadButton.count(), 0, "Download should only appear after a PDF is generated");
    await urlInput.fill("https://fixture.example/article");
    await page.getByRole("button", { name: "Create PDF" }).click();
    await preview.locator("canvas").first().waitFor();
    const downloadPromise = page.waitForEvent("download");
    await downloadButton.click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "fixture.example.pdf");
    const downloadedChunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream()) downloadedChunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(downloadedChunks), pdfBytes,
      "Download must save the exact PDF bytes displayed in the preview");
    assert.equal(
      await page.getByLabel("Generated PDF").count(),
      1,
      "The PDF preview must still render when expansion diagnostics are missing",
    );
    const text = page.locator(".pdf-text-layer span").filter({ hasText: "Select this PDF text" });
    await text.waitFor({ state: "visible" });
    await text.scrollIntoViewIfNeeded();
    const bounds = await text.boundingBox();
    assert.ok(bounds, "The selectable PDF text must have a visible hit area");
    await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.match(
      await page.evaluate(() => window.getSelection()?.toString() || ""),
      /Select this PDF text/,
      "Dragging across the rendered PDF must select its text",
    );
    assert.equal(
      await page.locator('.pdf-page-link[href="https://example.com/linked"]').count(),
      1,
      "PDF hyperlinks must be clickable in the preview",
    );
    await preview.getByRole("status").waitFor({ state: "hidden" });
    assert.equal(await preview.getByRole("alert").count(), 0, "The PDF viewer must not report a rendering error");
    assert.equal(await preview.locator("canvas").count(), expectedPages, "The preview must contain every PDF page");
    for (let pageNumber = 1; pageNumber <= expectedPages; pageNumber += 1) {
      const canvas = preview.locator(`canvas[aria-label="PDF page ${pageNumber}"]`);
      assert.equal(await canvas.count(), 1, `PDF page ${pageNumber} must have a canvas`);
      assert.ok(await canvas.isVisible(), `PDF page ${pageNumber} must be visible`);
      const inkPixels = await canvas.evaluate((element) => {
        if (!(element instanceof HTMLCanvasElement)) return 0;
        const context = element.getContext("2d", { willReadFrequently: true });
        if (!context) return 0;
        const { data } = context.getImageData(0, 0, element.width, element.height);
        let count = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index + 3] > 0 &&
              (data[index] < 220 || data[index + 1] < 220 || data[index + 2] < 220)) {
            count += 1;
          }
        }
        return count;
      });
      assert.ok(inkPixels > 100, `PDF page ${pageNumber} must contain document ink (found ${inkPixels} pixels)`);
    }
    assert.equal(await page.locator("iframe").count(), 0, "The PDF must not use an iframe preview");
    assert.equal(await page.getByTestId("expansion-summary").count(), 0, "No expansion-summary metadata should be displayed");
    assert.equal(await page.getByTestId("expansion-warning").count(), 0, "No diagnostics warning should be displayed");
    assert.ok(workerResponses > 0, "The PDF.js worker must load successfully");
    assert.deepEqual(browserErrors, [], "The PDF.js worker and browser console must have no errors");

    summaryHeader = JSON.stringify(validSummary);
    await urlInput.fill("https://fixture.example/article-with-summary");
    await page.getByRole("button", { name: "Create PDF" }).click();
    await preview.locator("canvas").first().waitFor();
    assert.equal(
      await page.getByTestId("expansion-summary").count(),
      0,
      "A valid expansion header must not add metadata to the preview",
    );
    assert.equal(
      await page.getByTestId("expansion-warning").count(),
      0,
      "A valid expansion header must not add a diagnostics warning",
    );
    assert.deepEqual(browserErrors, [], "The browser console must remain error-free after another capture");
  } finally {
    await browser.close();
  }
} finally {
  frontend.kill();
}

process.stdout.write("Webpage-to-PDF diagnostics UI test passed\n");
