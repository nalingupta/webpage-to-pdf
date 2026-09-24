import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import express from "express";
import { chromium } from "playwright-core";
import { PDFDocument } from "pdf-lib";
import { hideConsentNotices } from "../src/lib/page-notices";
import { expandDisclosures } from "../src/lib/page-expansion";
import { forcePrintDisclosures, restorePrintDisclosures } from "../src/lib/print-expansion";
import { collectCarouselSlides, appendCarouselPages } from "../src/lib/page-carousels";
import type { CarouselSummary } from "../src/lib/page-carousels";
import type { ExpansionSummary as ServerExpansionSummary } from "../src/lib/page-expansion";
import type { PdfStage } from "../src/lib/pdf-renderer";
import { createPdfRouter } from "../src/routes/pdf";
import {
  expansionSummarySchema,
  parseExpansionSummaryHeader,
} from "../../webpage-to-pdf/src/lib/expansion-summary";

const browser = await chromium.launch({
  executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.setContent(`
    <style>
      body { font-family: sans-serif; }
      .privacy-notice { position: fixed; bottom: 0; left: 0; width: 100%; height: 100px; background: white; z-index: 100; }
      .carousel { width: 300px; height: 120px; border: 1px solid #555; }
      .carousel-shell { width: 320px; margin-top: 20px; }
      [data-carousel] { width: 300px; height: 120px; border: 1px solid #555; }
      #clipped { max-height: 10px; overflow: hidden; }
      #lazy-spacer { height: 1200px; }
    </style>
    <article><p id="ordinary">A privacy policy article about cookies should remain.</p></article>
    <header id="site-header" style="position:fixed;top:0"><a href="#policy">Privacy policy</a></header>
    <div class="privacy-notice" role="dialog">
      <h2>Cookie Notice</h2>We use cookies for tracking.
      <button>Reject</button>
    </div>
    <div id="generic-popup" role="dialog" style="position:fixed;top:120px;background:white;width:240px;height:90px">
      Privacy Notice: we use cookies. <button>Manage preferences</button>
    </div>
    <details id="outer-detail"><summary>Details</summary><p>Hidden native details</p>
      <details id="inner-detail"><summary>Nested details</summary><p>Nested native content</p></details>
    </details>
    <details name="exclusive" id="first-exclusive" open><summary>First exclusive</summary>First content</details>
    <details name="exclusive" id="second-exclusive"><summary>Second exclusive</summary>Second content</details>
    <button aria-expanded="false" aria-controls="accordion" onclick="this.setAttribute('aria-expanded','true');document.getElementById('accordion').hidden=false">Open section</button>
    <div id="accordion" hidden>Accordion content
      <button role="button" aria-expanded="false" aria-controls="nested" onclick="this.setAttribute('aria-expanded','true');document.getElementById('nested').hidden=false">Open nested section</button>
      <div id="nested" hidden>Nested accordion content</div>
    </div>
    <button aria-expanded="false" aria-controls="stubborn">View details</button>
    <div id="stubborn" hidden>Panel shown through safe fallback</div>
    <button aria-expanded="false" aria-controls="clipped">Expand clipped section</button>
    <div id="clipped"><p>A long clipped paragraph whose full content should become visible in the captured page.</p></div>
    <button aria-expanded="false" aria-controls="missing">Open unavailable section</button>
    <section class="faq">
      <div class="accordion-item">
        <div class="accordion-header" role="button" aria-expanded="false">Why is the answer hidden?</div>
        <div class="accordion-content collapsed" inert aria-hidden="true" style="display:none; visibility:hidden; opacity:0; height:0; max-height:0; overflow:hidden; content-visibility:hidden; transform:translateY(99999px)">Forced FAQ answer visible in print.</div>
      </div>
      <button id="reverse-trigger" aria-expanded="false">Open reverse-labelled answer</button>
      <div aria-labelledby="reverse-trigger" hidden>Answer linked by aria-labelledby.</div>
    </section>
    <section class="specs">
      <table><tbody><tr><td>Visible specification</td></tr></tbody>
        <tbody class="specs__hidden" style="display:none"><tr><td>Additional hidden specification</td></tr></tbody>
      </table>
      <button type="button" class="specs__toggle">View all 19 specifications</button>
    </section>
    <section class="single-open-accordion">
      <button id="single-a" aria-expanded="false" aria-controls="single-a-panel"
        onclick="document.querySelectorAll('.single-open-accordion [aria-expanded]').forEach((button) => button.setAttribute('aria-expanded', 'false'));document.querySelectorAll('.single-open-accordion [id$=panel]').forEach((panel) => panel.hidden = true);this.setAttribute('aria-expanded','true');document.getElementById('single-a-panel').hidden=false">Single A</button>
      <div id="single-a-panel" hidden>Single-open first state.</div>
      <button id="single-b" aria-expanded="false" aria-controls="single-b-panel"
        onclick="document.querySelectorAll('.single-open-accordion [aria-expanded]').forEach((button) => button.setAttribute('aria-expanded', 'false'));document.querySelectorAll('.single-open-accordion [id$=panel]').forEach((panel) => panel.hidden = true);this.setAttribute('aria-expanded','true');document.getElementById('single-b-panel').hidden=false">Single B</button>
      <div id="single-b-panel" hidden>Single-open second state.</div>
    </section>
    <section class="framework-accordion">
      <button data-state="closed" aria-controls="framework-panel"
        onclick="this.dataset.state='open';document.getElementById('framework-panel').classList.remove('collapsed');document.getElementById('framework-panel').hidden=false">Framework-managed section</button>
      <div id="framework-panel" class="collapsed" hidden>Framework-managed content.</div>
    </section>
    <div id="lazy-spacer"></div>
    <div id="lazy-mount"></div>
    <iframe id="same-origin-frame" title="Same-origin disclosure frame"></iframe>
    <div role="dialog" aria-modal="true"><button aria-expanded="false" aria-controls="modal-panel">Open modal content</button><div id="modal-panel" hidden>Do not reveal modal content.</div></div>
    <button id="unsafe" aria-expanded="false" onclick="window.unsafeClicked=true">Buy now</button>
    <form onsubmit="window.formSubmitted=true;return false"><button>Show more products</button></form>
    <button id="mount-more" onclick="this.remove();document.getElementById('mounted').innerHTML='<button aria-expanded=&quot;false&quot; aria-controls=&quot;dynamic&quot; onclick=&quot;this.setAttribute(\\'aria-expanded\\',\\'true\\');document.getElementById(\\'dynamic\\').hidden=false&quot;>Open dynamically mounted section</button><p id=&quot;dynamic&quot; hidden>Dynamic nested content</p>'">Load more</button>
    <div id="mounted"></div>
    <a href="#" onclick="document.getElementById('more').hidden=false">Show more</a>
    <p id="more" hidden>Additional content</p>
    <div class="carousel" role="region" aria-label="Sample carousel">
      <p id="slide">First slide</p>
      <button aria-label="Next slide" onclick="document.getElementById('slide').textContent = document.getElementById('slide').textContent === 'First slide' ? 'Second slide' : 'First slide'">Next</button>
    </div>
    <div class="carousel-shell">
      <div data-carousel aria-label="Outside control carousel">
        <div id="outside-track">Outside first slide</div>
      </div>
      <button id="outside-next" aria-label="Next slide" aria-controls="outside-track"
        onclick="document.getElementById('outside-track').textContent = document.getElementById('outside-track').textContent === 'Outside first slide' ? 'Outside second slide' : 'Outside first slide'">Next outside track</button>
    </div>
    <div id="shadow-host"></div>
    <script>
      const root = document.getElementById('shadow-host').attachShadow({mode:'open'});
      root.innerHTML = '<details id="shadow-detail"><summary>Shadow details</summary>Shadow body</details>' +
        '<button aria-expanded="false" aria-controls="shadow-panel" onclick="this.setAttribute(\\'aria-expanded\\',\\'true\\');this.nextElementSibling.hidden=false">Expand shadow accordion</button>' +
        '<div id="shadow-panel" hidden>Shadow panel content</div>';
      window.addEventListener('scroll', () => {
        if (!document.getElementById('lazy-trigger')) {
          document.getElementById('lazy-mount').innerHTML = '<button id="lazy-trigger" aria-expanded="false" aria-controls="lazy-panel" onclick="this.setAttribute(\\'aria-expanded\\',\\'true\\');document.getElementById(\\'lazy-panel\\').hidden=false">Lazy section</button><div id="lazy-panel" hidden>Lazy-loaded content</div>';
        }
      });
    </script>
  `);
  await page.locator("#same-origin-frame").evaluate((frame) => {
    frame.setAttribute("srcdoc", `
      <button id="frame-trigger" aria-expanded="false" aria-controls="frame-panel"
        onclick="this.setAttribute('aria-expanded','true');document.getElementById('frame-panel').hidden=false">Frame section</button>
      <div id="frame-panel" hidden>Same-origin frame content.</div>
    `);
  });
  await page.waitForTimeout(150);
  assert.equal(await hideConsentNotices(page), 2);
  assert.equal(await page.locator(".privacy-notice").count(), 0);
  assert.equal(await page.locator("#generic-popup").count(), 0);
  assert.equal(await page.locator("#ordinary").count(), 1);
  assert.equal(await page.locator("#site-header").count(), 1);
  const separateStates: { image: Buffer; heading: string }[] = [];
  const summary = await expandDisclosures(page, () => {}, (state) => separateStates.push(state));
  assert.ok(summary.diagnostics.some((item) => item.strategy === "details forced open"), JSON.stringify(summary));
  const forced = await forcePrintDisclosures(page);
  assert.ok(forced.diagnostics.some((item) => item.strategy === "hidden panel CSS overridden"), JSON.stringify(forced));
  assert.ok(summary.nativeDetailsOpened >= 4, JSON.stringify(summary));
  assert.ok(summary.disclosuresOpened >= 4, JSON.stringify(summary));
  assert.ok(summary.showMoreActivated >= 2, JSON.stringify(summary));
  assert.ok(summary.detected >= 15 && summary.opened >= 12 && summary.skipped >= 1, JSON.stringify(summary));
  assert.ok(summary.passesCompleted >= 2, JSON.stringify(summary));
  assert.ok(summary.remainingCollapsed >= 1, JSON.stringify(summary));
  assert.equal(await page.locator("#outer-detail").getAttribute("open"), "");
  assert.equal(await page.locator("#inner-detail").getAttribute("open"), "");
  assert.equal(await page.locator("#first-exclusive").getAttribute("open"), "");
  assert.equal(await page.locator("#second-exclusive").getAttribute("open"), "");
  assert.equal(await page.locator("#shadow-host").locator("#shadow-detail").getAttribute("open"), "");
  assert.equal(await page.locator("#accordion").isVisible(), true);
  assert.equal(await page.locator("#nested").isVisible(), true);
  assert.equal(await page.locator("#stubborn").isVisible(), true);
  assert.equal(await page.locator("#dynamic").isVisible(), true);
  assert.equal(await page.locator("#clipped").evaluate((el) => el.scrollHeight <= el.clientHeight + 8), true);
  assert.equal(await page.locator("#shadow-host").locator("#shadow-panel").isVisible(), true);
  assert.equal(await page.locator("#more").isVisible(), true);
  assert.equal(await page.locator("#framework-panel").isVisible(), true);
  assert.equal(await page.locator("#lazy-panel").isVisible(), true);
  assert.equal(await page.frames().find((frame) => frame !== page.mainFrame())?.locator("#frame-panel").isVisible(), true);
  assert.ok(separateStates.length >= 1, "Single-open accordion should produce a separate state page");
  assert.equal(await page.getByText("Forced FAQ answer visible in print.").isVisible(), true);
  assert.equal(await page.getByText("Answer linked by aria-labelledby.").isVisible(), true);
  assert.equal(await page.getByText("Additional hidden specification").isVisible(), true);
  assert.equal(await page.locator(".specs__hidden").evaluate((el) => getComputedStyle(el).display), "table-row-group");
  assert.equal(await page.locator("#modal-panel").isVisible(), false);
  assert.equal(await page.evaluate(() => (window as Window & { unsafeClicked?: boolean }).unsafeClicked), undefined);
  assert.equal(await page.evaluate(() => (window as Window & { formSubmitted?: boolean }).formSubmitted), undefined);
  const initial = await page.pdf({ format: "A4", printBackground: true });
  await restorePrintDisclosures(page);
  assert.equal(await page.getByText("Forced FAQ answer visible in print.").isVisible(), false);
  assert.equal(await page.getByText("Additional hidden specification").isVisible(), false);
  let carouselSummary: { detected: number; captured: number; skipped: number } | undefined;
  const slides = await collectCarouselSlides(page, () => {}, (summary) => { carouselSummary = summary; });
  assert.ok(slides.length >= 2, "Carousels should produce additional states for inside and outside controls");
  assert.ok(carouselSummary, "Carousel capture should report a structured summary");
  assert.equal(carouselSummary?.captured, slides.length);
  assert.ok((carouselSummary?.detected || 0) >= 2);
  const result = await appendCarouselPages(initial, slides, "A4", false);
  const initialPdf = await PDFDocument.load(initial);
  const pdf = await PDFDocument.load(result);
  assert.equal(pdf.getPageCount(), initialPdf.getPageCount() + slides.length);
  const navigationPage = await browser.newPage();
  await navigationPage.setContent(
    `<button aria-expanded="false" onclick="location.href='https://example.org/'">Expand section</button>`,
  );
  const originalUrl = navigationPage.url();
  await expandDisclosures(navigationPage);
  assert.equal(navigationPage.url(), originalUrl, "Expansion must not navigate to another page");
  await navigationPage.close();
  const serverSummary: ServerExpansionSummary & { carousel: CarouselSummary } = {
    detected: 5,
    opened: 3,
    skipped: 2,
    nativeDetailsOpened: 1,
    disclosuresOpened: 1,
    showMoreActivated: 1,
    passesCompleted: 4,
    remainingCollapsed: 2,
    carousel: { detected: 2, captured: 3, skipped: 1 },
    diagnostics: [
      { label: "Normally clicked", strategy: "clicked normally" },
      { label: "Native details", strategy: "details forced open" },
      { label: "ARIA panel", strategy: "aria-controlled panel forced visible" },
      { label: "Print-only panel", strategy: "hidden panel CSS overridden" },
      { label: "Unavailable panel", strategy: "unresolved" },
    ],
  };
  const expandedPdfResponse = new Response(Buffer.from("%PDF-1.7"), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "X-Expansion-Summary": JSON.stringify(serverSummary),
    },
  });
  assert.equal(expandedPdfResponse.ok, true);
  assert.match(expandedPdfResponse.headers.get("content-type") || "", /application\/pdf/);
  assert.deepEqual(
    parseExpansionSummaryHeader(expandedPdfResponse.headers.get("X-Expansion-Summary")),
    expansionSummarySchema.parse(serverSummary),
    "The successful expanded PDF response must remain readable by the client schema",
  );
  assert.deepEqual(
    parseExpansionSummaryHeader(expandedPdfResponse.headers.get("X-Expansion-Summary"))?.carousel,
    { detected: 2, captured: 3, skipped: 1 },
    "Carousel capture counts must remain visible after the PDF response completes",
  );
  assert.equal(parseExpansionSummaryHeader(null), null, "A missing summary must keep diagnostics unavailable");
  assert.equal(parseExpansionSummaryHeader("not-json"), null, "A malformed summary must keep diagnostics unavailable");
  assert.equal(
    parseExpansionSummaryHeader(JSON.stringify({
      ...serverSummary,
      diagnostics: [{ label: "Unknown strategy", strategy: "future strategy" }],
    })),
    null,
    "An unknown diagnostic strategy must keep diagnostics unavailable",
  );
  assert.equal(
    parseExpansionSummaryHeader(JSON.stringify({ ...serverSummary, futureField: true })),
    null,
    "An unexpected summary field must keep diagnostics unavailable",
  );
  const integrationApp = express();
  integrationApp.use(express.json());
  integrationApp.use("/api", createPdfRouter({
    assertPublicUrl: async () => new URL("https://fixture.example/expanded"),
    renderPdf: async (
      _url: URL,
      _format: "A4" | "Letter" | "Legal",
      _landscape: boolean,
      options: { hideNotices: boolean; expandedCapture: boolean },
      progress: (stage: PdfStage, message: string) => void,
      onExpansion: (summary: ServerExpansionSummary) => void,
      onCarousel: (summary: CarouselSummary) => void,
    ) => {
      assert.equal(options.expandedCapture, true, "The route must pass through expanded capture");
      progress("expanding", "Fixture expansion complete");
      onExpansion(serverSummary);
      onCarousel(serverSummary.carousel);
      const fixturePdf = await PDFDocument.create();
      fixturePdf.addPage();
      return Buffer.from(await fixturePdf.save());
    },
  }));
  const server = await new Promise<ReturnType<typeof integrationApp.listen>>((resolve, reject) => {
    const listener = integrationApp.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string", "Fixture API should listen on an ephemeral TCP port");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://fixture.example/expanded",
        pageSize: "A4",
        orientation: "portrait",
        hideNotices: true,
        expandedCapture: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /application\/pdf/);
    const responsePdf = Buffer.from(await response.arrayBuffer());
    assert.equal(responsePdf.subarray(0, 5).toString(), "%PDF-");
    const responseSummary = parseExpansionSummaryHeader(response.headers.get("X-Expansion-Summary"));
    assert.deepEqual(
      responseSummary,
      expansionSummarySchema.parse({ ...serverSummary, carousel: serverSummary.carousel }),
      "The live expanded PDF response must retain diagnostics in a schema-valid header",
    );
    assert.ok(
      responseSummary?.diagnostics.some((item) => item.strategy === "hidden panel CSS overridden"),
      "The live PDF response must keep expansion diagnostics visible",
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  process.stdout.write(`Capture smoke test passed (${slides.length} additional carousel pages)\n`);
} finally {
  await browser.close();
}