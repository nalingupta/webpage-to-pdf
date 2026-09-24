import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { PdfError, rendererUnavailable } from "./pdf-errors";

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function chromiumExecutable(): string {
  const configured = process.env.CHROMIUM_PATH;
  if (configured) {
    if (isAbsolute(configured) && executable(configured)) return configured;
    throw rendererUnavailable(new Error("Configured Chromium executable is not accessible"));
  }
  const names = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (executable(candidate)) return candidate;
    }
  }
  throw rendererUnavailable(new Error("No Chromium executable found on PATH"));
}

export async function launchPdfBrowser(): Promise<Browser> {
  const executablePath = chromiumExecutable();
  try {
    return await chromium.launch({
      headless: true,
      executablePath,
      timeout: 15_000,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (cause) {
    throw rendererUnavailable(cause);
  }
}

let lastCheck: { checkedAt: number; promise: Promise<void> } | undefined;

/** Test the actual browser and PDF pipeline, without network access. */
export function selfTestPdfRenderer(): Promise<void> {
  if (lastCheck && Date.now() - lastCheck.checkedAt < 60_000) return lastCheck.promise;
  const promise = (async () => {
    const browser = await launchPdfBrowser();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const pdf = await Promise.race([
        (async () => {
          const page = await browser.newPage();
          await page.setContent("<!doctype html><title>Renderer check</title><h1>PDF ready</h1>", {
            waitUntil: "domcontentloaded",
            timeout: 5_000,
          });
          return page.pdf({ format: "A4", printBackground: true });
        })(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new PdfError(
            "RENDER_TIMEOUT", 503, "The PDF renderer self-test timed out.",
          )), 12_000);
        }),
      ]);
      if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw new Error("Browser did not produce a valid PDF");
      }
    } catch (cause) {
      if (cause instanceof PdfError) throw cause;
      throw rendererUnavailable(cause);
    } finally {
      if (deadline) clearTimeout(deadline);
      await browser.close().catch(() => {});
    }
  })();
  lastCheck = { checkedAt: Date.now(), promise };
  return promise;
}