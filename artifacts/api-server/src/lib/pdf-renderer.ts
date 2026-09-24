import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { errors as playwrightErrors } from "playwright-core";
import { launchPdfBrowser } from "./chromium-runtime";
import { printDesktopPage } from "./desktop-print";
import { PdfError } from "./pdf-errors";
import { hideConsentNotices } from "./page-notices";
import { expandDisclosures, unresolvedDisclosures } from "./page-expansion";
import type { ExpansionState, ExpansionSummary } from "./page-expansion";
import { forcePrintDisclosures, restorePrintDisclosures } from "./print-expansion";
import {
  appendCarouselPages,
  collectCarouselSlides,
  type CarouselSummary,
} from "./page-carousels";

export type PdfStage = "loading" | "removing" | "expanding" | "carousels" | "rendering";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
  ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b:1::", 48],
] as const) blocked.addSubnet(address, prefix, "ipv6");

export class UnsafeUrlError extends Error {}

export async function assertPublicUrl(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeUrlError("Enter a valid URL starting with https:// or http://.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (url.port && !["80", "443"].includes(url.port)) || !url.hostname ||
      url.href.length > 2048) {
    throw new UnsafeUrlError("Only public HTTP or HTTPS webpages are supported.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname.includes(".") && !isIP(hostname)) {
    throw new UnsafeUrlError("Enter a public webpage address.");
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError("That webpage address could not be found.");
  }
  if (!addresses.length || addresses.some(({ address, family }) => {
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    const mappedHex = address.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/i);
    if (mappedHex) {
      const number = (parseInt(mappedHex[1], 16) * 65536 + parseInt(mappedHex[2], 16)) >>> 0;
      return blocked.check(
        `${number >>> 24}.${(number >>> 16) & 255}.${(number >>> 8) & 255}.${number & 255}`,
        "ipv4",
      );
    }
    return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
  })) {
    throw new UnsafeUrlError("Private or reserved network addresses are not allowed.");
  }
  return url;
}

export async function renderPdf(
  url: URL,
  format: "A4" | "Letter" | "Legal",
  landscape: boolean,
  options: { hideNotices: boolean; expandedCapture: boolean },
  progress: (stage: PdfStage, message: string) => void = () => {},
  onExpansion: (summary: ExpansionSummary) => void = () => {},
  onCarousel: (summary: CarouselSummary) => void = () => {},
): Promise<Buffer> {
  const browser = await launchPdfBrowser();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const capture = async (): Promise<Buffer> => {
      const viewportWidth = landscape ? 1280 : 1080;
      const context = await browser.newContext({
      viewport: { width: viewportWidth, height: 820 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
      });
      try {
      await context.route("**/*", async (route) => {
        try {
          await assertPublicUrl(route.request().url());
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      progress("loading", "Loading webpage and lazy-loaded content…");
      let response;
      try {
        response = await page.goto(url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: 25_000,
        });
      } catch (cause) {
        if (cause instanceof playwrightErrors.TimeoutError) {
          throw new PdfError(
            "NAVIGATION_TIMEOUT", 504,
            "The destination webpage took too long to open. Try again or use a faster page.",
            cause,
          );
        }
        throw new PdfError(
          "WEBSITE_UNREACHABLE", 502,
          "The destination webpage could not be reached or redirected to an unsupported address.",
          cause,
        );
      }
      if (!response) {
        throw new PdfError("WEBSITE_UNREACHABLE", 502, "The destination webpage did not return a page.");
      }
      if ([401, 403, 429].includes(response.status())) {
        throw new PdfError(
          "WEBSITE_BLOCKED", 502,
          "This website requires sign-in or blocks automated browsers. Try another public page.",
        );
      }
      if (response.status() >= 400) {
        throw new PdfError(
          "WEBSITE_UNREACHABLE", 502,
          `The destination webpage returned HTTP ${response.status()}. Check the URL and try again.`,
        );
      }
      const title = await page.title().catch(() => "");
      if (/^(just a moment|attention required|access denied|verify you are human|checking your browser)/i.test(title)) {
        throw new PdfError(
          "WEBSITE_BLOCKED", 502,
          "This website appears to block automated browsers. Try another public page.",
        );
      }
      await page.emulateMedia({ media: "screen" });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(700);

      // Scroll through the document to trigger intersection-observer and image loading.
      for (let step = 0; step < 15; step++) {
        const reachedBottom = await page.evaluate(() => {
          window.scrollBy(0, Math.max(600, window.innerHeight * 0.9));
          return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 10;
        });
        await page.waitForTimeout(230);
        if (reachedBottom) break;
      }
      await page.evaluate(async () => {
        window.scrollTo(0, 0);
        await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
      });
      if (options.hideNotices) {
        progress("removing", "Removing cookie and privacy notices…");
        await hideConsentNotices(page);
      }
      let expansionSummary: ExpansionSummary | undefined;
      const expansionStates: ExpansionState[] = [];
      if (options.expandedCapture) {
        progress("expanding", "Expanding sections and show-more content…");
        expansionSummary = await expandDisclosures(page, (summary) => {
          onExpansion(summary);
          progress("expanding", summary.detected === 0
            ? "No expandable content detected yet; checking lazy-loaded page content…"
            : summary.opened === 0
              ? `Detected ${summary.detected} expandable controls, but none opened; ${summary.skipped} skipped.`
              : `Opened ${summary.opened} of ${summary.detected} expandable controls; ` +
                `${summary.skipped} skipped, ${summary.remainingCollapsed} still collapsed.`);
        }, (state) => expansionStates.push(state));
      }
      if (options.hideNotices) await hideConsentNotices(page);
      if (expansionSummary) {
        progress("expanding", "Checking hidden disclosure panels for print…");
        const forced = await forcePrintDisclosures(page);
        const remaining = await unresolvedDisclosures(page, expansionSummary.diagnostics);
        expansionSummary.diagnostics = [...expansionSummary.diagnostics, ...forced.diagnostics, ...remaining]
          .filter((item, index, all) => all.findIndex(
            (other) => other.label === item.label && other.strategy === item.strategy,
          ) === index).slice(0, 70);
        expansionSummary.remainingCollapsed = Math.max(remaining.length, forced.unresolved);
        onExpansion(expansionSummary);
      }
      progress("rendering", "Rendering webpage PDF…");
      let initial: Buffer;
      try {
        initial = await printDesktopPage(page, format, landscape, viewportWidth);
      } finally {
        if (expansionSummary) await restorePrintDisclosures(page);
      }
      let pdf: Buffer = initial;
      if (options.expandedCapture) {
        pdf = await appendCarouselPages(initial, expansionStates, format, landscape);
        progress("carousels", "Collecting carousel slides…");
        const slides = await collectCarouselSlides(
          page,
          (message) => progress("carousels", message),
          onCarousel,
        );
        progress("rendering", "Adding carousel slides to the PDF…");
        pdf = await appendCarouselPages(pdf, slides, format, landscape);
      }
      if (pdf.length > 30 * 1024 * 1024) {
        throw new PdfError("PDF_TOO_LARGE", 502, "This page produced a PDF larger than 30 MB.");
      }
      return pdf;
      } finally {
        await context.close().catch(() => {});
      }
    };
    return await Promise.race([
      capture(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new PdfError(
          "RENDER_TIMEOUT", 504,
          "PDF capture took too long on this page. Try normal capture or a shorter page.",
        )), options.expandedCapture ? 85_000 : 55_000);
      }),
    ]);
  } catch (cause) {
    if (cause instanceof PdfError || cause instanceof UnsafeUrlError) throw cause;
    throw new PdfError(
      "RENDERER_FAILED", 503,
      "The PDF renderer failed while processing this page. Please try again later.",
      cause,
    );
  } finally {
    if (deadline) clearTimeout(deadline);
    await browser.close().catch(() => {});
  }
}