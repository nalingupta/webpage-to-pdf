import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { hideConsentNotices } from "../src/lib/page-notices";

const browser = await chromium.launch({
  executablePath: execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
  args: ["--no-sandbox"],
});

try {
  const page = await browser.newPage();
  await page.setContent(`
    <article><h1>EV tax credit update</h1><p>Keep this article.</p></article>
    <div id="transcend-consent-manager" style="position:fixed;z-index:2147483647"></div>
    <script>
      document.getElementById('transcend-consent-manager').attachShadow({mode:'closed'}).innerHTML =
        '<div style="position:fixed;bottom:0;background:white">To provide the best experience, we use cookies.</div>';
    </script>
  `);
  assert.equal(await page.locator("#transcend-consent-manager").evaluate((el) => el.getBoundingClientRect().width), 0);
  const before = await page.pdf({ format: "A4" });
  assert.match(execFileSync("pdftotext", ["-", "-"], { input: before, encoding: "utf8" }), /To provide the best experience/);

  assert.equal(await hideConsentNotices(page), 1);
  assert.equal(await page.locator("#transcend-consent-manager").count(), 0);
  const after = await page.pdf({ format: "A4" });
  const text = execFileSync("pdftotext", ["-", "-"], { input: after, encoding: "utf8" });
  assert.doesNotMatch(text, /To provide the best experience/);
  assert.match(text, /Keep this article/);
} finally {
  await browser.close();
}

process.stdout.write("Consent notice capture test passed\n");