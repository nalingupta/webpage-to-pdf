import { PDFDocument } from "pdf-lib";
import type { Page } from "playwright-core";

const MM_TO_POINTS = 72 / 25.4;
const MARGIN_POINTS = 12 * MM_TO_POINTS;

const paperSizes = {
  A4: [210 * MM_TO_POINTS, 297 * MM_TO_POINTS],
  Letter: [612, 792],
  Legal: [612, 1008],
} as const;

/**
 * Chromium lays out print pages at the paper's CSS width, even with screen
 * media emulation and page.pdf({ scale }). Print at desktop width first, then
 * shrink the vector PDF (including text and link annotations) onto the requested
 * paper size. This keeps responsive grids at their desktop breakpoint.
 */
export async function printDesktopPage(
  page: Page,
  format: keyof typeof paperSizes,
  landscape: boolean,
  viewportWidth: number,
): Promise<Buffer> {
  const [shortSide, longSide] = paperSizes[format];
  const paperWidth = landscape ? longSide : shortSide;
  const paperHeight = landscape ? shortSide : longSide;
  const desktopWidthPoints = viewportWidth * 72 / 96;
  const scale = (paperWidth - 2 * MARGIN_POINTS) / desktopWidthPoints;
  const sourceMargin = MARGIN_POINTS / scale;
  const asInches = (points: number) => `${points / 72}in`;

  const widePdf = await page.pdf({
    width: asInches(paperWidth / scale),
    height: asInches(paperHeight / scale),
    preferCSSPageSize: false,
    printBackground: true,
    margin: {
      top: asInches(sourceMargin),
      right: asInches(sourceMargin),
      bottom: asInches(sourceMargin),
      left: asInches(sourceMargin),
    },
  });

  const document = await PDFDocument.load(widePdf);
  for (const pdfPage of document.getPages()) {
    pdfPage.scale(scale, scale);
    // Chromium rounds its source page dimensions to fractional PDF points.
    pdfPage.setSize(paperWidth, paperHeight);
  }
  return Buffer.from(await document.save());
}