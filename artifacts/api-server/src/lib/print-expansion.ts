import type { Page } from "playwright-core";
import type { ExpansionDiagnostic } from "./page-expansion";

type PrintResult = { diagnostics: ExpansionDiagnostic[]; unresolved: number };

/**
 * The PDF page is disposable. Keep print-only mutations separate and restore
 * them before carousel capture.
 */
export async function forcePrintDisclosures(page: Page): Promise<PrintResult> {
  return page.evaluate(() => {
    type Saved = {
      style: string | null;
      className: string | null;
      attributes: Record<string, string | null>;
      open?: boolean;
    };
    const saved = new Map<Element, Saved>();
    const state = window as Window & { __pdfPrintExpansion?: Map<Element, Saved> };
    state.__pdfPrintExpansion = saved;
    const diagnostics: ExpansionDiagnostic[] = [];
    let unresolved = 0;
    const roots: (Document | ShadowRoot)[] = [document];
    const excluded = "nav,header,footer,[role='navigation'],[role='menu'],[role='menubar'],[role='dialog']," +
      "[aria-modal='true'],[role='tablist'],[aria-roledescription='carousel'],.swiper,.slick-slider," +
      ".splide,.embla,.carousel,[id^='onetrust'],[class*='cookie' i],[class*='consent' i]," +
      "[class*='offcanvas' i],[class*='off-canvas' i],[class*='drawer' i],[class*='mobile-menu' i]," +
      "[class*='cart' i],[class*='checkout' i]";
    const panelLike = /(?:answer|content|panel|body|region|collapse|accordion|disclosure|expand|more|faq)/i;
    const moreLabel = /\b(?:show|view|read|see|load|display|reveal)\s+(?:some\s+)?(?:more|all|full|details?|content|comments?)\b|\bcontinue\s+reading\b/i;
    const unsafe = /\b(?:buy|purchase|checkout|add to cart|subscribe|sign\s*(?:in|up|out)|log\s*(?:in|out)|delete|remove|unsubscribe|send|save|submit|pay|order|download|accept|reject|next|previous)\b/i;
    const helper = {
      remember(el: Element) {
        if (saved.has(el)) return;
        saved.set(el, {
          style: el.getAttribute("style"),
          className: el.getAttribute("class"),
          attributes: Object.fromEntries(
            ["hidden", "inert", "aria-hidden", "aria-expanded", "data-state", "data-expanded", "name"]
              .map((key) => [key, el.getAttribute(key)]),
          ),
          ...(el instanceof HTMLDetailsElement ? { open: el.open } : {}),
        });
      },
      excludedRegion(el: Element) {
        let current: Element | null = el;
        while (current) {
          if (current.matches(excluded)) return true;
          current = current.parentElement || ((current.getRootNode() as ShadowRoot).host ?? null);
        }
        return false;
      },
      isPanel(el: Element | null | undefined): el is HTMLElement {
        if (!(el instanceof HTMLElement) || helper.excludedRegion(el) || el.matches("button,summary,a,form")) return false;
        return !!el.textContent?.trim() || !!el.querySelector("img,details,[role='region']");
      },
      open(panel: HTMLElement) {
        helper.remember(panel);
        const initial = getComputedStyle(panel);
        const clipped = panel.scrollHeight > panel.clientHeight + 5 &&
          /hidden|clip|auto|scroll/.test(initial.overflowY);
        const cssHidden = panel.hasAttribute("hidden") || panel.hasAttribute("inert") ||
          panel.getAttribute("aria-hidden") === "true" || initial.display === "none" ||
          initial.visibility !== "visible" || Number(initial.opacity) < 0.05 ||
          initial.contentVisibility === "hidden" || clipped || panel.getBoundingClientRect().height < 2;
        panel.removeAttribute("hidden");
        panel.removeAttribute("inert");
        if (panel.hasAttribute("aria-hidden")) panel.setAttribute("aria-hidden", "false");
        if (panel.getAttribute("data-state") === "closed") panel.setAttribute("data-state", "open");
        if (panel.getAttribute("data-expanded") === "false") panel.setAttribute("data-expanded", "true");
        for (const token of Array.from(panel.classList)) {
          if (/^(?:collapsed|is-collapsed|is-hidden|hidden|closed)$/.test(token)) panel.classList.remove(token);
        }
        if (initial.display === "none" || panel.getBoundingClientRect().height < 2) {
          const tableDisplay: Record<string, string> = {
            TBODY: "table-row-group", THEAD: "table-header-group", TFOOT: "table-footer-group",
            TR: "table-row", TD: "table-cell", TH: "table-cell",
          };
          panel.style.setProperty("display", tableDisplay[panel.tagName] || "block", "important");
        }
        if (initial.visibility !== "visible") panel.style.setProperty("visibility", "visible", "important");
        if (Number(initial.opacity) < 1) panel.style.setProperty("opacity", "1", "important");
        if (initial.contentVisibility !== "visible") panel.style.setProperty("content-visibility", "visible", "important");
        if (clipped || panel.getBoundingClientRect().height < 2) {
          panel.style.setProperty("height", "auto", "important");
          panel.style.setProperty("max-height", "none", "important");
          panel.style.setProperty("min-height", "0", "important");
          panel.style.setProperty("overflow", "visible", "important");
        }
        const rect = panel.getBoundingClientRect();
        if (initial.transform !== "none" &&
            (Math.abs(rect.x) > 10_000 || Math.abs(rect.y) > 10_000 || rect.height < 2)) {
          panel.style.setProperty("transform", "none", "important");
        }
        if (initial.clipPath !== "none" && /inset\(\s*100%|circle\(\s*0/.test(initial.clipPath)) {
          panel.style.setProperty("clip-path", "none", "important");
        }
        return cssHidden;
      },
      shown(panel: HTMLElement) {
        const style = getComputedStyle(panel);
        return panel.getClientRects().length > 0 && !panel.hasAttribute("hidden") &&
          !panel.hasAttribute("inert") && panel.getAttribute("aria-hidden") !== "true" &&
          style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0 &&
          style.contentVisibility !== "hidden" && !(panel.scrollHeight > panel.clientHeight + 8 &&
            /hidden|clip/.test(style.overflowY));
      },
      targetFor(el: Element): HTMLElement | null {
        const root = el.getRootNode() as Document | ShadowRoot;
        const ids = (el.getAttribute("aria-controls") || "").trim().split(/\s+/).filter(Boolean);
        for (const id of ids) {
          const target = (root instanceof ShadowRoot ? root.getElementById(id) : document.getElementById(id)) ||
            document.getElementById(id);
          if (helper.isPanel(target)) return target;
        }
        if (el.id) {
          for (const target of Array.from(root.querySelectorAll("[aria-labelledby]"))) {
            if (target.getAttribute("aria-labelledby")?.split(/\s+/).includes(el.id) &&
                helper.isPanel(target)) return target;
          }
        }
        const label = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 90);
        if (moreLabel.test(label)) {
          const section = el.closest("section,article,[role='region']");
          if (section && !helper.excludedRegion(section)) {
            const prefix = Array.from(el.classList)
              .map((name) => name.match(/^([a-z][a-z0-9-]+)(?:__|-)/i)?.[1]).find(Boolean);
            const hidden = Array.from(section.querySelectorAll(
              "[hidden],[inert],[aria-hidden='true'],[class*='hidden' i],[class*='collapse' i]," +
              "[style*='display: none']",
            )).filter((item) => helper.isPanel(item) && !item.matches(".sr-only,[class*='screen-reader' i]")) as HTMLElement[];
            const match = hidden.find((item) => prefix &&
              Array.from(item.classList).some((name) => name.startsWith(`${prefix}__`) || name.startsWith(`${prefix}-`)));
            if (match) return match;
            if (hidden.length === 1 && panelLike.test(`${hidden[0].className} ${hidden[0].id}`)) return hidden[0];
          }
        }
        const region = el.closest("[class*='accordion' i],[class*='faq' i],[class*='disclosure' i],[data-accordion]");
        if (!region || helper.excludedRegion(region)) return null;
        const neighbours = [el.nextElementSibling, el.parentElement?.nextElementSibling,
          ...Array.from(region.children).filter((child) => child !== el && !child.contains(el))];
        for (const candidate of neighbours) {
          if (helper.isPanel(candidate) && (candidate.matches("[role='region'],[hidden],[inert],[aria-hidden='true']") ||
              panelLike.test(`${candidate.className} ${candidate.id}`))) return candidate;
        }
        return null;
      },
    };

    for (let pass = 0; pass < 8; pass++) {
      let changes = 0;
      for (let i = 0; i < roots.length; i++) {
        for (const el of Array.from(roots[i].querySelectorAll("*")).slice(0, 12_000)) {
          if (el.shadowRoot && !roots.includes(el.shadowRoot)) roots.push(el.shadowRoot);
        }
      }
      for (const root of roots) {
        for (const details of Array.from(root.querySelectorAll("details"))) {
          if (!(details instanceof HTMLDetailsElement) || helper.excludedRegion(details)) continue;
          const label = details.querySelector("summary")?.textContent?.trim().slice(0, 90) || "Details";
          if (!details.open || details.hasAttribute("name")) {
            helper.remember(details);
            details.removeAttribute("name");
            details.open = true;
            changes++;
            diagnostics.push({ label, strategy: "details forced open" });
          }
          for (const child of Array.from(details.children)) {
            if (child.tagName === "SUMMARY" || !helper.isPanel(child)) continue;
            if (!helper.shown(child)) {
              helper.open(child);
              changes++;
              diagnostics.push({ label, strategy: "hidden panel CSS overridden" });
            }
          }
        }
        for (const trigger of Array.from(root.querySelectorAll(
          "button,[role='button'],a[href^='#'],[aria-expanded],[aria-controls],[data-state='closed'],.accordion-header,.accordion-button",
        ))) {
          if (!(trigger instanceof HTMLElement) || helper.excludedRegion(trigger)) continue;
          if (trigger.matches("[disabled],[aria-disabled='true'],[aria-haspopup],[role='tab'],[type='submit'],[type='reset']")) continue;
          const label = (trigger.getAttribute("aria-label") || trigger.textContent || "").trim().slice(0, 90);
          if (unsafe.test(label)) continue;
          const panel = helper.targetFor(trigger);
          if (!panel || (helper.shown(panel) && trigger.getAttribute("aria-expanded") !== "false")) continue;
          helper.remember(trigger);
          trigger.setAttribute("aria-expanded", "true");
          if (trigger.getAttribute("data-state") === "closed") trigger.setAttribute("data-state", "open");
          trigger.classList.remove("collapsed", "is-collapsed");
          const hiddenCss = helper.open(panel);
          let parent = panel.parentElement;
          while (parent && parent !== document.body && !helper.excludedRegion(parent)) {
            if (!helper.shown(parent) && panelLike.test(`${parent.className} ${parent.id}`)) helper.open(parent);
            parent = parent.parentElement;
          }
          if (helper.shown(panel)) {
            changes++;
            diagnostics.push({ label, strategy: trigger.hasAttribute("aria-controls") && !hiddenCss
              ? "aria-controlled panel forced visible" : "hidden panel CSS overridden" });
          } else {
            unresolved++;
            diagnostics.push({ label, strategy: "unresolved" });
          }
        }
      }
      if (!changes) break;
    }
    return { diagnostics, unresolved };
  });
}

export async function restorePrintDisclosures(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Saved = { style: string | null; className: string | null; attributes: Record<string, string | null>; open?: boolean };
    const state = window as Window & { __pdfPrintExpansion?: Map<Element, Saved> };
    for (const [el, before] of Array.from(state.__pdfPrintExpansion || []).reverse()) {
      if (!el.isConnected) continue;
      for (const [key, value] of Object.entries(before.attributes)) {
        if (value === null) el.removeAttribute(key);
        else el.setAttribute(key, value);
      }
      if (before.className === null) el.removeAttribute("class");
      else el.setAttribute("class", before.className);
      if (before.style === null) el.removeAttribute("style");
      else el.setAttribute("style", before.style);
      if (el instanceof HTMLDetailsElement && before.open !== undefined) el.open = before.open;
    }
    delete state.__pdfPrintExpansion;
  }).catch(() => {});
}