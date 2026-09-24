import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Frame, Page } from "playwright-core";

type Paper = "A4" | "Letter" | "Legal";
const sizes: Record<Paper, [number, number]> = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
  Legal: [612, 1008],
};

type Slide = { image: Buffer; heading: string };
export type CarouselSummary = { detected: number; captured: number; skipped: number };
type CarouselDescriptor = { id: string; controlId: string; label: string };
type FrameCarousels = { frame: Frame; index: number; carousels: CarouselDescriptor[] };

/** Find carousel tracks and controls in one document, including open shadow roots. */
function inspectCarousels(): CarouselDescriptor[] {
  const rootSelector =
    '[aria-roledescription="carousel"],[role="region"][aria-label*="carousel" i],' +
    '.swiper:not(.swiper-wrapper),.slick-slider,.splide,.embla,.glide,' +
    '.carousel:not(.carousel-item),[data-testid*="carousel" i],[data-carousel]';
  const controlSelector = [
    'button[aria-label*="next slide" i]',
    'button[aria-label*="next item" i]',
    'button[aria-label*="next" i]',
    '[role="button"][aria-label*="next" i]',
    '[data-slide="next"]', '[data-carousel-next]',
    '.swiper-button-next', '.slick-next', '.splide__arrow--next',
    '.carousel-control-next', '[data-bs-slide="next"]',
  ].join(",");
  const roots: (Document | ShadowRoot)[] = [document];
  const found = new Set<Element>();
  const descriptors: CarouselDescriptor[] = [];
  let nextId = 0;
  const helper = {
    isCarouselLike(el: Element | null) {
      return !!el && (
        el.matches("[aria-roledescription='carousel'],.swiper,.slick-slider,.splide,.embla,.glide,.carousel,[data-carousel]") ||
        /carousel|slider|swiper|slick|splide|embla|glide/i.test(`${el.className} ${el.id}`)
      );
    },
    assign(el: Element, prefix: string) {
      const key = `pdf-${prefix}-${++nextId}`;
      if (!el.getAttribute(`data-pdf-${prefix}-id`)) el.setAttribute(`data-pdf-${prefix}-id`, key);
      return el.getAttribute(`data-pdf-${prefix}-id`)!;
    },
  };
  for (let index = 0; index < roots.length && index < 100; index++) {
    const root = roots[index];
    for (const element of Array.from(root.querySelectorAll("*")).slice(0, 15_000)) {
      if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
      if (!element.matches(rootSelector) || found.has(element)) continue;
      found.add(element);
      const rootId = helper.assign(element, "carousel");
      const track = element.matches(".swiper-wrapper,.slick-list,.splide__track,[data-carousel-track]")
        ? element
        : element.querySelector(".swiper-wrapper,.slick-list,.splide__track,[data-carousel-track]") || element;
      const trackId = helper.assign(track, "track");
      const scope = element.getRootNode() as Document | ShadowRoot;
      const controls = Array.from(scope.querySelectorAll(controlSelector)).filter((control) => {
        if (element.contains(control)) return true;
        const linked = (control.getAttribute("aria-controls") || "").split(/\s+/);
        if (linked.includes(rootId) || linked.includes(trackId) ||
            (element.id && linked.includes(element.id)) || (track.id && linked.includes(track.id))) return true;
        const owner = control.closest(
          "[aria-roledescription='carousel'],.swiper,.slick-slider,.splide,.embla,.glide,.carousel,[data-carousel]"
        );
        return owner === element || (!!owner && element.contains(owner)) ||
          (element.parentElement !== null && element.parentElement.contains(control) &&
            helper.isCarouselLike(element.parentElement));
      });
      for (const control of controls) {
        const controlId = helper.assign(control, "carousel-control");
        descriptors.push({
          id: rootId,
          controlId,
          label: (element.getAttribute("aria-label") || element.getAttribute("data-testid") ||
            `Carousel ${descriptors.length + 1}`).slice(0, 80),
        });
      }
    }
  }
  return descriptors.filter((descriptor, index, all) =>
    all.findIndex((other) => other.id === descriptor.id) === index);
}

async function scanFrames(page: Page): Promise<FrameCarousels[]> {
  const result: FrameCarousels[] = [];
  for (const [index, frame] of page.frames().entries()) {
    try {
      result.push({ frame, index, carousels: await frame.evaluate(inspectCarousels) });
    } catch {
      // Cross-origin and detached frames are not scriptable from this capture.
    }
  }
  return result;
}

function hash(image: Buffer): string {
  return createHash("sha256").update(image).digest("hex");
}

async function stateSignature(root: ReturnType<Frame["locator"]>): Promise<string> {
  return root.evaluate((element) => {
    const active = element.querySelector(
      "[aria-current='true'],[aria-selected='true'],.active,.is-active,.swiper-slide-active," +
      ".slick-active,.splide__slide.is-active"
    );
    return [
      active?.textContent?.trim(),
      active?.getAttribute("data-index"),
      active?.getAttribute("aria-label"),
      element.textContent?.trim().slice(0, 500),
      (element as HTMLElement).style.transform,
    ].join("|");
  }).catch(() => "");
}

/** Step accessible carousel controls and record only visually distinct slides. */
export async function collectCarouselSlides(
  page: Page,
  report: (message: string) => void,
  onSummary: (summary: CarouselSummary) => void = () => {},
): Promise<Slide[]> {
  const slides: Slide[] = [];
  let detected = 0;
  let skipped = 0;
  for (const scan of await scanFrames(page)) {
    detected += scan.carousels.length;
    for (const carousel of scan.carousels) {
      const rootSelector = `[data-pdf-carousel-id="${carousel.id}"]`;
      const controlSelector = `[data-pdf-carousel-control-id="${carousel.controlId}"]`;
      const root = scan.frame.locator(rootSelector).first();
      try {
        const visible = await root.isVisible();
        const bounds = visible ? await root.boundingBox() : null;
        if (!visible || !bounds) {
          skipped++;
          report(`Skipped ${carousel.label}: carousel is not visible.`);
          continue;
        }
        if (bounds.width < 120 || bounds.height < 60 || bounds.height > 2500) {
          skipped++;
          report(`Skipped ${carousel.label}: carousel bounds are not capturable.`);
          continue;
        }
        const control = scan.frame.locator(controlSelector).first();
        if (!(await control.count()) || !(await control.isVisible())) {
          skipped++;
          report(`Skipped ${carousel.label}: next control was not visible.`);
          continue;
        }
        const signatures = new Set<string>();
        await page.mouse.move(0, 0);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => {});
        const original = await root.screenshot({ type: "jpeg", quality: 50, timeout: 3_000 });
        signatures.add(hash(original));
        for (let step = 1; step <= 12 && slides.length < 24; step++) {
          const currentRoot = scan.frame.locator(rootSelector).first();
          const currentControl = scan.frame.locator(controlSelector).first();
          if (!(await currentControl.isVisible()) || !(await currentControl.isEnabled())) {
            skipped++;
            report(`Skipped ${carousel.label}: next control became unavailable at slide ${step}.`);
            break;
          }
          const beforeState = await stateSignature(currentRoot);
          await currentControl.click({ timeout: 1_800 });
          let stateChanged = false;
          for (let wait = 0; wait < 25; wait++) {
            await page.waitForTimeout(100);
            if ((await stateSignature(scan.frame.locator(rootSelector).first())) !== beforeState) {
              stateChanged = true;
              break;
            }
          }
          await page.waitForTimeout(180);
          await page.mouse.move(0, 0);
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => {});
          const image = await scan.frame.locator(rootSelector).first().screenshot({
            type: "jpeg", quality: 50, timeout: 3_000,
          });
          const signature = hash(image);
          if (signatures.has(signature)) {
            if (!stateChanged) skipped++;
            break;
          }
          signatures.add(signature);
          slides.push({ image, heading: `${carousel.label} — slide ${step + 1}` });
          report(`Collecting carousel slides (${slides.length} found)…`);
        }
      } catch (error) {
        skipped++;
        const reason = error instanceof Error ? error.message.split("\n")[0] : "control interaction failed";
        report(`Skipped ${carousel.label}: ${reason}.`);
      }
    }
  }
  const summary = { detected, captured: slides.length, skipped };
  report(`Detected ${summary.detected} carousel(s); captured ${summary.captured} additional state(s); skipped ${summary.skipped}.`);
  onSummary(summary);
  return slides;
}

export async function appendCarouselPages(
  initial: Buffer,
  slides: Slide[],
  paper: Paper,
  landscape: boolean,
): Promise<Buffer> {
  if (!slides.length) return initial;
  const pdf = await PDFDocument.load(initial);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const [short, long] = sizes[paper];
  const [width, height] = landscape ? [long, short] : [short, long];
  for (const slide of slides) {
    const image = await pdf.embedJpg(slide.image);
    const sheet = pdf.addPage([width, height]);
    sheet.drawText(slide.heading.replace(/[^\x20-\x7e]/g, "-"), {
      x: 34, y: height - 42, font, size: 12, color: rgb(.15, .2, .3),
      maxWidth: width - 68,
    });
    const scale = Math.min((width - 68) / image.width, (height - 95) / image.height);
    sheet.drawImage(image, {
      x: (width - image.width * scale) / 2,
      y: height - 68 - image.height * scale,
      width: image.width * scale,
      height: image.height * scale,
    });
  }
  return Buffer.from(await pdf.save());
}