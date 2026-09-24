import type { Frame, Page, Route } from "playwright-core";
import { PdfError } from "./pdf-errors";

export type ExpansionSummary = {
  detected: number;
  opened: number;
  skipped: number;
  nativeDetailsOpened: number;
  disclosuresOpened: number;
  showMoreActivated: number;
  passesCompleted: number;
  remainingCollapsed: number;
  diagnostics: ExpansionDiagnostic[];
};

export type ExpansionDiagnostic = {
  label: string;
  strategy: "clicked normally" | "details forced open" | "aria-controlled panel forced visible" |
    "hidden panel CSS overridden" | "unresolved";
};

export type ExpansionState = { image: Buffer; heading: string };

type Candidate = {
  id: string;
  label: string;
  kind: "disclosure" | "showMore";
  hasPanel: boolean;
  groupKey: string | null;
};

type FrameScan = {
  frame: Frame;
  index: number;
  candidates: Candidate[];
  details: number;
  detailLabels: string[];
};

type StateSnapshot = {
  expanded: boolean;
  panelVisible: boolean;
  label: string;
  textLength: number;
  height: number;
};

/** Runs inside one document. Shadow roots are traversed; closed roots cannot be inspected. */
function inspectPage(openDetails: boolean): {
  details: number;
  detailLabels: string[];
  candidates: Candidate[];
} {
  const roots: (Document | ShadowRoot)[] = [document];
  const candidates: Candidate[] = [];
  const detailLabels: string[] = [];
  const moreLabel = /\b(?:show|view|read|see|load|display|reveal)\s+(?:some\s+)?(?:more|all|full|details?|content|comments?)\b|\bexpand(?:\s+all)?\b|\bcontinue\s+reading\b|^more(?:\s*[.…])?$/i;
  const unsafe = /\b(?:buy|purchase|checkout|add to cart|subscribe|sign\s*(?:in|up|out)|log\s*(?:in|out)|delete|remove|unsubscribe|send|save|submit|pay|order|download|accept|reject|next|previous)\b/i;
  const helper = {
    visible(el: Element) {
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
    },
    panelOpen(el: Element) {
      const style = getComputedStyle(el);
      return helper.visible(el) && !el.hasAttribute("hidden") && !el.hasAttribute("inert") &&
        el.getAttribute("aria-hidden") !== "true" &&
        !(el.scrollHeight > el.clientHeight + 8 && /hidden|clip/.test(style.overflowY));
    },
    ancestorExcluded(el: Element) {
      let current: Element | null = el;
      while (current) {
        if (current.matches(
          "nav,header,footer,form[role='search'],[role='navigation'],[role='menu']," +
          "[role='menubar'],[role='tablist'],[role='dialog'],[aria-modal='true']," +
          "[aria-roledescription='carousel'],.swiper,.slick-slider,.splide,.embla,.carousel"
        )) return true;
        current = current.parentElement || ((current.getRootNode() as ShadowRoot).host ?? null);
      }
      return false;
    },
    rootFor(el: Element): Document | ShadowRoot {
      const root = el.getRootNode();
      return root instanceof ShadowRoot ? root : document;
    },
    getById(root: Document | ShadowRoot, id: string) {
      return root.getElementById(id) || document.getElementById(id);
    },
    panelLike(el: Element) {
      return !el.matches("button,summary,a,form") &&
        (!!el.textContent?.trim() || !!el.querySelector("img,details,[role='region']"));
    },
    panelFor(el: Element): Element | null {
      const root = helper.rootFor(el);
      const ids = (el.getAttribute("aria-controls") || "").trim().split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const panel = helper.getById(root, id);
        if (panel && helper.panelLike(panel)) return panel;
      }
      if (el.id) {
        for (const panel of Array.from(root.querySelectorAll("[aria-labelledby]"))) {
          if (panel.getAttribute("aria-labelledby")?.split(/\s+/).includes(el.id) && helper.panelLike(panel)) return panel;
        }
      }
      const region = el.closest("section,article,[role='region'],[class*='accordion' i],[class*='disclosure' i]," +
        "[class*='faq' i],[data-accordion]");
      if (!region || helper.ancestorExcluded(region)) return null;
      const hidden = Array.from(region.querySelectorAll(
        "[hidden],[inert],[aria-hidden='true'],[class*='hidden' i],[class*='collapse' i]," +
        "[class*='content' i],[class*='panel' i],[style*='display: none']"
      )).filter((item) => helper.panelLike(item) && !item.matches(".sr-only,[class*='screen-reader' i]"));
      const prefix = Array.from(el.classList)
        .map((name) => name.match(/^([a-z][a-z0-9-]+)(?:__|-)/i)?.[1])
        .find(Boolean);
      const related = hidden.find((item) => prefix &&
        Array.from(item.classList).some((name) => name.startsWith(`${prefix}__`) || name.startsWith(`${prefix}-`)));
      if (related) return related;
      const neighbours = [
        el.nextElementSibling,
        el.parentElement?.nextElementSibling,
        ...Array.from(region.children).filter((child) => child !== el && !child.contains(el)),
      ].filter((item): item is Element => !!item);
      return neighbours.find((item) => helper.panelLike(item) &&
        (item.matches("[role='region'],[hidden],[inert],[aria-hidden='true']") ||
          /(?:answer|content|panel|body|collapse|accordion|disclosure|expand|more|faq)/i.test(
            `${item.className} ${item.id}`,
          ))) || (hidden.length === 1 ? hidden[0] : null);
    },
    groupFor(el: Element): string | null {
      const group = el.closest(
        "[data-single-open],[data-accordion],[class*='accordion' i],[class*='disclosure' i],[class*='faq' i]"
      );
      if (!group || helper.ancestorExcluded(group)) return null;
      const htmlGroup = group as HTMLElement;
      if (!htmlGroup.dataset.pdfExpandGroup) {
        const holder = window as Window & { __pdfExpandNextGroup?: number };
        htmlGroup.dataset.pdfExpandGroup = String(
          holder.__pdfExpandNextGroup = (holder.__pdfExpandNextGroup || 0) + 1,
        );
      }
      return htmlGroup.dataset.pdfExpandGroup;
    },
  };

  for (let index = 0; index < roots.length && index < 100; index++) {
    const root = roots[index];
    for (const el of Array.from(root.querySelectorAll("*")).slice(0, 12_000)) {
      if (el.shadowRoot && !roots.includes(el.shadowRoot)) roots.push(el.shadowRoot);
      if (!openDetails || !(el instanceof HTMLDetailsElement) || helper.ancestorExcluded(el) || el.open) continue;
      // Named details are safe to make simultaneous for a static capture.
      el.removeAttribute("name");
      el.open = true;
      detailLabels.push(el.querySelector("summary")?.textContent?.trim().slice(0, 90) || "Details");
    }
  }

  const selectors = [
    "button,[role='button'],a[href^='#'],[aria-expanded='false'],[aria-controls]",
    "[data-state='closed'],[data-expanded='false'],.accordion-header,.accordion-button",
    "[data-accordion-trigger],[data-disclosure-trigger]",
  ].join(",");
  let visited = 0;
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll(selectors))) {
      if (++visited > 12_000) break;
      if (!(el instanceof HTMLElement) || helper.ancestorExcluded(el) || !helper.visible(el)) continue;
      if (el.matches("[disabled],[aria-disabled='true'],[aria-haspopup],[role='tab'],[type='submit'],[type='reset']")) continue;
      if (el instanceof HTMLButtonElement && el.closest("form") && el.type !== "button") continue;
      if (el instanceof HTMLAnchorElement && !/^#[^\s]*$/.test(el.getAttribute("href") || "")) continue;
      if (/\b(?:location|history|window\.open|navigate|router|submit\s*\()/i.test(el.getAttribute("onclick") || "")) continue;
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 120);
      if (unsafe.test(label)) continue;
      const panel = helper.panelFor(el);
      if (panel?.matches("[role='menu'],[role='dialog'],[role='listbox'],[role='tablist']")) continue;
      if (el.getAttribute("aria-expanded") === "true" || el.getAttribute("data-state") === "open" ||
          el.getAttribute("data-expanded") === "true" || (panel && helper.panelOpen(panel))) continue;
      const collapsed = el.getAttribute("aria-expanded") === "false" ||
        el.getAttribute("data-state") === "closed" || el.getAttribute("data-expanded") === "false" ||
        !!(panel && !helper.panelOpen(panel) &&
          /(?:accordion|disclosure|collapsed|expand|content|panel)/i.test(`${el.className} ${el.id}`));
      const showMore = moreLabel.test(label);
      if (!collapsed && !showMore) continue;
      if (!el.dataset.pdfExpandId) {
        const holder = window as Window & { __pdfExpandNextId?: number };
        el.dataset.pdfExpandId = String(holder.__pdfExpandNextId = (holder.__pdfExpandNextId || 0) + 1);
      }
      candidates.push({
        id: el.dataset.pdfExpandId,
        label,
        kind: collapsed && panel ? "disclosure" : showMore ? "showMore" : "disclosure",
        hasPanel: !!panel,
        groupKey: helper.groupFor(el),
      });
    }
  }
  return { details: detailLabels.length, detailLabels, candidates };
}

function snapshot(el: Element): StateSnapshot {
  const root = el.getRootNode();
  const ids = (el.getAttribute("aria-controls") || "").trim().split(/\s+/).filter(Boolean);
  let panel: Element | null = null;
  for (const id of ids) {
    panel = (root instanceof ShadowRoot ? root.getElementById(id) : document.getElementById(id)) ||
      document.getElementById(id);
    if (panel) break;
  }
  const panelVisible = !!panel && !panel.hasAttribute("hidden") && !panel.hasAttribute("inert") &&
    panel.getAttribute("aria-hidden") !== "true" && panel.getClientRects().length > 0 &&
    getComputedStyle(panel).display !== "none" && getComputedStyle(panel).visibility !== "hidden" &&
    !(panel.scrollHeight > panel.clientHeight + 8 && /hidden|clip/.test(getComputedStyle(panel).overflowY));
  return {
    expanded: el.getAttribute("aria-expanded") === "true" || el.getAttribute("data-state") === "open" ||
      el.getAttribute("data-expanded") === "true",
    panelVisible,
    label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 120),
    textLength: document.body?.innerText.length || 0,
    height: document.documentElement.scrollHeight,
  };
}

function revealPanel(el: Element): boolean {
  const root = el.getRootNode();
  const ids = (el.getAttribute("aria-controls") || "").trim().split(/\s+/).filter(Boolean);
  const panel = ids.map((id) =>
    (root instanceof ShadowRoot ? root.getElementById(id) : document.getElementById(id)) ||
    document.getElementById(id),
  ).find((item) => !!item) || null;
  if (!panel || panel.matches("[role='menu'],[role='dialog'],[role='listbox'],[role='tablist']")) return false;
  panel.removeAttribute("hidden");
  panel.removeAttribute("inert");
  panel.setAttribute("aria-hidden", "false");
  const html = panel as HTMLElement;
  const style = getComputedStyle(panel);
  if (style.display === "none") html.style.setProperty("display", "block", "important");
  html.style.setProperty("visibility", "visible", "important");
  html.style.setProperty("height", "auto", "important");
  html.style.setProperty("max-height", "none", "important");
  html.style.setProperty("overflow", "visible", "important");
  el.setAttribute("aria-expanded", "true");
  return panel.getClientRects().length > 0 && getComputedStyle(panel).display !== "none";
}

async function scanFrames(page: Page): Promise<FrameScan[]> {
  const scans: FrameScan[] = [];
  for (const [index, frame] of page.frames().entries()) {
    try {
      const result = await frame.evaluate(inspectPage, true);
      scans.push({ frame, index, ...result });
    } catch {
      // Cross-origin and detached frames cannot be inspected safely.
    }
  }
  return scans;
}

async function scrollPageAndFrames(page: Page, scans: FrameScan[]): Promise<boolean> {
  let allAtBottom = await page.evaluate(() => {
    window.scrollBy(0, Math.max(500, innerHeight * 0.85));
    return scrollY + innerHeight >= document.documentElement.scrollHeight - 12;
  }).catch(() => true);
  for (const scan of scans) {
    const frameAtBottom = await scan.frame.evaluate(() => {
      window.scrollBy(0, Math.max(450, innerHeight * 0.85));
      return scrollY + innerHeight >= document.documentElement.scrollHeight - 12;
    }).catch(() => true);
    allAtBottom = allAtBottom && frameAtBottom;
  }
  return allAtBottom;
}

export async function expandDisclosures(
  page: Page,
  report: (summary: ExpansionSummary) => void = () => {},
  onSeparateState: (state: ExpansionState) => void = () => {},
): Promise<ExpansionSummary> {
  const originalUrl = page.url().split("#")[0];
  const blockNavigation = (route: Route) => {
    if (route.request().isNavigationRequest()) return route.abort("blockedbyclient");
    return route.fallback();
  };
  await page.route("**/*", blockNavigation);
  try {
    const summary: ExpansionSummary = {
      detected: 0, opened: 0, skipped: 0,
      nativeDetailsOpened: 0, disclosuresOpened: 0, showMoreActivated: 0,
      passesCompleted: 0, remainingCollapsed: 0, diagnostics: [],
    };
    const detected = new Set<string>();
    const opened = new Set<string>();
    const attempted = new Set<string>();
    const lastOpenedByGroup = new Map<string, { frame: Frame; id: string; label: string }>();
    const capturedGroups = new Set<string>();
    const addDiagnostic = (item: ExpansionDiagnostic) => {
      if (summary.diagnostics.length < 100) summary.diagnostics.push(item);
    };
    const capturePreviousState = async (groupKey: string, previous: { frame: Frame; id: string; label: string }) => {
      if (capturedGroups.has(groupKey) || capturedGroups.size >= 8) return;
      const locator = previous.frame.locator(`[data-pdf-expand-id="${previous.id}"]`);
      if (!(await locator.count().catch(() => 0)) || !(await locator.isVisible().catch(() => false))) return;
      const state = await locator.evaluate(snapshot).catch(() => null);
      if (!state?.panelVisible) return;
      try {
        const image = await page.screenshot({ type: "jpeg", quality: 50, fullPage: true, animations: "disabled" });
        onSeparateState({ image, heading: `${previous.label || "Accordion"} — separate state` });
        capturedGroups.add(groupKey);
      } catch {
        summary.skipped++;
        addDiagnostic({ label: previous.label, strategy: "unresolved" });
      }
    };

    let idlePasses = 0;
    for (let pass = 0; pass < 20 && attempted.size < 120; pass++) {
      const scans = await scanFrames(page);
      let changes = 0;
      for (const scan of scans) {
        if (scan.details) {
          summary.nativeDetailsOpened += scan.details;
          summary.opened += scan.details;
          changes += scan.details;
          for (const label of scan.detailLabels) {
            addDiagnostic({ label, strategy: "details forced open" });
          }
        }
        for (const control of scan.candidates) {
          const key = `${scan.index}:${control.id}`;
          detected.add(key);
          if (attempted.has(key) || attempted.size >= 120) continue;
          attempted.add(key);
          const locator = scan.frame.locator(`[data-pdf-expand-id="${control.id}"]`);
          try {
            if (!(await locator.isVisible())) {
              summary.skipped++;
              continue;
            }
            const before = await locator.evaluate(snapshot);
            if (before.expanded || before.panelVisible) continue;
            if (control.groupKey) {
              const previous = lastOpenedByGroup.get(`${scan.index}:${control.groupKey}`);
              if (previous) await capturePreviousState(`${scan.index}:${control.groupKey}`, previous);
            }
            if (await locator.evaluate((el) => el instanceof HTMLAnchorElement)) {
              await locator.evaluate((el) =>
                el.addEventListener("click", (event) => event.preventDefault(), { once: true, capture: true }));
            }
            const currentMainUrl = page.url().split("#")[0];
            const currentFrameUrl = scan.frame.url().split("#")[0];
            await locator.click({ timeout: 1_600 });
            await page.waitForTimeout(220);
            if (page.url().split("#")[0] !== currentMainUrl || scan.frame.url().split("#")[0] !== currentFrameUrl) {
              throw new Error("Disclosure attempted to navigate away");
            }
            let after = await locator.evaluate(snapshot).catch(() => null);
            if (control.hasPanel && !after?.panelVisible) {
              const forced = await locator.evaluate(revealPanel).catch(() => false);
              if (forced) after = await locator.evaluate(snapshot).catch(() => null);
              if (forced && after?.panelVisible) {
                changes++;
                opened.add(key);
                summary.disclosuresOpened++;
                summary.opened++;
                addDiagnostic({ label: control.label, strategy: "aria-controlled panel forced visible" });
                if (control.groupKey) lastOpenedByGroup.set(`${scan.index}:${control.groupKey}`, {
                  frame: scan.frame, id: control.id, label: control.label,
                });
                continue;
              }
            }
            const changed = after ? (control.hasPanel ? after.panelVisible :
              after.expanded || after.label !== before.label ||
              after.textLength > before.textLength + 5 || after.height > before.height + 8) :
              await scan.frame.evaluate(({ textLength, height }) =>
                (document.body?.innerText.length || 0) > textLength + 5 ||
                document.documentElement.scrollHeight > height + 8, before).catch(() => false);
            if (!changed) {
              summary.skipped++;
              addDiagnostic({ label: control.label, strategy: "unresolved" });
              continue;
            }
            changes++;
            opened.add(key);
            summary.opened++;
            if (control.kind === "showMore") {
              summary.showMoreActivated++;
            } else {
              summary.disclosuresOpened++;
            }
            addDiagnostic({ label: control.label, strategy: "clicked normally" });
            if (control.groupKey) lastOpenedByGroup.set(`${scan.index}:${control.groupKey}`, {
              frame: scan.frame, id: control.id, label: control.label,
            });
          } catch {
            summary.skipped++;
            addDiagnostic({ label: control.label, strategy: "unresolved" });
            if (page.url().split("#")[0] !== originalUrl) {
              throw new PdfError(
                "WEBSITE_UNREACHABLE", 502,
                "This page tried to navigate away during expansion, so capture stopped for safety.",
              );
            }
          }
        }
      }
      summary.detected = detected.size;
      summary.passesCompleted++;
      const atBottom = await scrollPageAndFrames(page, scans);
      await page.waitForTimeout(180);
      if (changes === 0) idlePasses++;
      else idlePasses = 0;
      if (idlePasses >= 2 && atBottom) {
        await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
        const settled = await scanFrames(page);
        const newControls = settled.some((scan) => scan.candidates.some((control) =>
          !attempted.has(`${scan.index}:${control.id}`)));
        if (newControls || settled.some((scan) => scan.details)) {
          idlePasses = 0;
          continue;
        }
        break;
      }
      report(summary);
    }

    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    for (const frame of page.frames().slice(1)) await frame.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
    await page.evaluate(async () => {
      const roots: (Document | ShadowRoot)[] = [document];
      const images: HTMLImageElement[] = [];
      for (let i = 0; i < roots.length; i++) {
        images.push(...Array.from(roots[i].querySelectorAll("img")));
        for (const element of Array.from(roots[i].querySelectorAll("*"))) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
        }
      }
      await Promise.race([
        Promise.allSettled([
          document.fonts.ready,
          ...images.filter((img) => img.getClientRects().length).slice(0, 100).map((img) => img.decode()),
        ]),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }).catch(() => {});

    summary.detected = detected.size;
    const finalScans = await scanFrames(page);
    const finalCandidates = finalScans.flatMap((scan) => scan.candidates.map((control) => ({
      key: `${scan.index}:${control.id}`, control,
    })));
    summary.remainingCollapsed = finalCandidates.filter(({ key, control }) =>
      !opened.has(key) && !!control.label,
    ).length;
    report(summary);
    return summary;
  } finally {
    await page.unroute("**/*", blockNavigation);
  }
}

export async function unresolvedDisclosures(page: Page, succeeded: ExpansionDiagnostic[]): Promise<ExpansionDiagnostic[]> {
  const successfulLabels = new Set(succeeded
    .filter((item) => item.strategy !== "unresolved")
    .map((item) => item.label));
  const remaining: ExpansionDiagnostic[] = [];
  for (const scan of await scanFrames(page)) {
    for (const candidate of scan.candidates) {
      if (!successfulLabels.has(candidate.label)) remaining.push({ label: candidate.label, strategy: "unresolved" });
    }
  }
  return remaining;
}