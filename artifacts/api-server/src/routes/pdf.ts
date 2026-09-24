import { Router, type IRouter } from "express";
import { CreatePdfBody, GetPdfProgressParams, GetPdfProgressResponse, PdfRendererHealthCheckResponse } from "@workspace/api-zod";
import { assertPublicUrl, renderPdf, UnsafeUrlError } from "../lib/pdf-renderer";
import type { PdfStage } from "../lib/pdf-renderer";
import { selfTestPdfRenderer } from "../lib/chromium-runtime";
import { PdfError } from "../lib/pdf-errors";
import type { ExpansionSummary } from "../lib/page-expansion";
import type { CarouselSummary } from "../lib/page-carousels";

const recent = new Map<string, number[]>();
let active = 0;
type Progress = { stage: "starting" | PdfStage | "complete" | "error"; message: string; updated: number };
const progressById = new Map<string, Progress>();

type PdfRouterDependencies = {
  assertPublicUrl: typeof assertPublicUrl;
  renderPdf: typeof renderPdf;
};

export function createPdfRouter(
  dependencies: Partial<PdfRouterDependencies> = {},
): IRouter {
  const assertPublicUrlForRequest = dependencies.assertPublicUrl || assertPublicUrl;
  const renderPdfForRequest = dependencies.renderPdf || renderPdf;
  const router: IRouter = Router();

  router.get("/pdf/healthz", async (req, res): Promise<void> => {
    try {
      await selfTestPdfRenderer();
      res.set("Cache-Control", "no-store").json(
        PdfRendererHealthCheckResponse.parse({ status: "ok", renderer: "ready" }),
      );
    } catch (error) {
      req.log.error({ err: error }, "PDF renderer self-test failed");
      res.status(503).set("Cache-Control", "no-store").json({
        error: "The PDF renderer is unavailable on this server.",
        code: "RENDERER_UNAVAILABLE",
      });
    }
  });

  router.get("/pdf/progress/:requestId", (req, res): void => {
    const params = GetPdfProgressParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid request ID." });
      return;
    }
    const state = progressById.get(params.data.requestId) || {
      stage: "starting" as const, message: "Preparing PDF capture…", updated: Date.now(),
    };
    res.set("Cache-Control", "no-store").json(GetPdfProgressResponse.parse(state));
  });

  router.post("/pdf", async (req, res): Promise<void> => {
    const parsed = CreatePdfBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a valid URL, page size, and orientation." });
      return;
    }
    const ip = req.ip || "unknown";
    const now = Date.now();
    const attempts = (recent.get(ip) || []).filter((time) => now - time < 60_000);
    if (attempts.length >= 6 || active >= 2) {
      res.status(429).json({ error: "The converter is busy. Please wait a moment and try again." });
      return;
    }
    recent.set(ip, [...attempts, now]);
    const requestId = parsed.data.requestId;
    const update = (stage: Progress["stage"], message: string) => {
      if (requestId) progressById.set(requestId, { stage, message, updated: Date.now() });
    };
    update("starting", "Preparing PDF capture…");
    if (recent.size > 2000) {
      for (const [key, times] of recent) {
        if (times.every((time) => now - time > 60_000)) recent.delete(key);
      }
    }
    for (const [key, state] of progressById) {
      if (now - state.updated > 90_000) progressById.delete(key);
    }
    active++;
    try {
      const url = await assertPublicUrlForRequest(parsed.data.url);
      let expansionSummary: ExpansionSummary | undefined;
      let carouselSummary: CarouselSummary | undefined;
      const pdf = await renderPdfForRequest(
        url, "A4", false,
        { hideNotices: parsed.data.hideNotices, expandedCapture: parsed.data.expandedCapture },
        update,
        (summary) => { expansionSummary = summary; },
        (summary) => { carouselSummary = summary; },
      );
      const filename = `${url.hostname.replace(/[^a-z0-9.-]/gi, "-").slice(0, 90)}.pdf`;
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (expansionSummary) {
        res.set("X-Expansion-Summary", JSON.stringify({
          ...expansionSummary,
          carousel: carouselSummary || { detected: 0, captured: 0, skipped: 0 },
        }));
      }
      res.send(pdf);
      update("complete", "PDF ready to preview.");
    } catch (error) {
      update("error", "PDF capture failed.");
      if (error instanceof UnsafeUrlError) {
        res.status(400).json({ error: error.message, code: "INVALID_URL" });
        return;
      }
      req.log.error({ err: error }, "PDF generation failed");
      if (error instanceof PdfError) {
        res.status(error.status).json({ error: error.publicMessage, code: error.code });
        return;
      }
      res.status(503).json({
        error: "The PDF renderer encountered an unexpected server error. Please try again later.",
        code: "RENDERER_FAILED",
      });
    } finally {
      active--;
    }
  });

  return router;
}

export default createPdfRouter();