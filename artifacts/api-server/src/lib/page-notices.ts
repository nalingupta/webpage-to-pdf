import type { Page } from "playwright-core";

/**
 * Remove consent UI, not articles about privacy or cookies. A candidate needs
 * both consent language and overlay/banner semantics or a known CMP identity.
 * Never click "accept": removing a notice must not record consent.
 */
export async function hideConsentNotices(page: Page): Promise<number> {
  return page.evaluate(() => {
    const known = [
      "#onetrust-banner-sdk", "#onetrust-consent-sdk",
      "#CybotCookiebotDialog", "#CybotCookiebotDialogBodyUnderlay",
      "#didomi-host", ".qc-cmp2-container", ".osano-cm-window",
      "#sp_message_container", ".fc-consent-root",
      "[data-testid='cookie-banner']", "[data-testid='cookie-consent']",
    ].join(",");
    const candidates = new Set<Element>();
    document.querySelectorAll(known).forEach((el) => candidates.add(el));
    document.querySelectorAll(
      "dialog,[role='dialog'],[role='alertdialog'],[aria-modal='true']," +
      "[role='banner'],[id*='cookie' i],[class*='cookie' i]," +
      "[id*='consent' i],[class*='consent' i]," +
      "[id*='privacy' i],[class*='privacy' i]," +
      "[id*='cmp' i],[class*='cmp' i]," +
      "[id*='notice' i],[class*='notice' i]," +
      "[id*='banner' i],[class*='banner' i]"
    ).forEach((el) => candidates.add(el));
    // Generic overlays sometimes have no consent-related class or role.
    // Consider only fixed/sticky visible elements with relevant wording.
    for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 3000)) {
      if ((el.textContent || "").length > 2500) continue;
      if (!/\b(cookie|privacy|consent|tracking)\b/i.test(el.textContent || "")) continue;
      if (["fixed", "sticky"].includes(getComputedStyle(el).position)) candidates.add(el);
    }

    const words = /\b(cookie(?:s)?|privacy|consent|tracking)\b/i;
    const actions = /\b(accept|reject|allow|agree|manage|preferences|settings|notice|policy|decline|opt.out)\b/i;
    const removed: Element[] = [];
    for (const el of candidates) {
      if (removed.some((parent) => parent.contains(el)) || el === document.body || el === document.documentElement) continue;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" ||
          rect.width < 100 || rect.height < 30 || rect.bottom < 0 || rect.top > innerHeight) continue;
      const identity = `${el.id} ${typeof el.className === "string" ? el.className : ""}`;
      const vendor = el.matches(known);
      const semantic = /(?:^|[\s_-])(cookie|consent|privacy|cmp)(?:[\s_-]|$)/i.test(identity);
      const text = (el.textContent || "").slice(0, 4000);
      const dialog = el.matches("dialog,[role='dialog'],[role='alertdialog'],[aria-modal='true']");
      const hasConsentAction = Array.from(el.querySelectorAll("button,[role='button'],input[type='button']")).some((button) =>
        /\b(accept|reject|allow|agree|manage|preferences|dismiss|close|got it|okay)\b/i.test(
          `${button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.getAttribute("value") || ""}`
        )
      );
      const overlay = ["fixed", "sticky"].includes(style.position) ||
        dialog ||
        (el.matches("[role='banner']") && rect.top > innerHeight * .5);
      const relevant = words.test(text) && (actions.test(text) || semantic);
      if (!vendor && !(overlay && relevant && (semantic || dialog || (text.length < 2500 && hasConsentAction)))) continue;
      if (!vendor && rect.width * rect.height > innerWidth * innerHeight * .92 && !semantic) continue;
      removed.push(el);
      el.remove();
    }
    if (removed.length) {
      // Many CMPs lock document scrolling while the dialog is visible.
      for (const el of [document.body, document.documentElement]) {
        if (getComputedStyle(el).overflow === "hidden") el.style.overflow = "auto";
      }
      document.querySelectorAll("[class*='backdrop' i],[class*='overlay' i]").forEach((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.position === "fixed" && rect.width >= innerWidth * .85 &&
            rect.height >= innerHeight * .85 && (el.textContent || "").trim().length < 60) el.remove();
      });
    }
    return removed.length;
  });
}