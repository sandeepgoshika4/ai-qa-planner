import type { Page } from "playwright";
import type { PageContext } from "../types/pageContext.js";

/**
 * Scroll all scrollable containers (window + overflow containers) to their
 * bottom, then back to the top.  This forces Angular / React components that
 * use IntersectionObserver or *ngIf-on-scroll to render their off-screen
 * children so the extractor can capture them.
 */
async function revealAllElements(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // Collect every scrollable container on the page
    const containers: Array<{ el: Element | null; max: number }> = [];

    // Window scroll
    const winMax = document.documentElement.scrollHeight - window.innerHeight;
    if (winMax > 10) containers.push({ el: null, max: winMax });

    // Overflow containers (modals, panels, sidebars, etc.)
    document.querySelectorAll("*").forEach((node) => {
      const el = node as HTMLElement;
      const style = window.getComputedStyle(el);
      const oy = style.overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 20) {
        containers.push({ el, max: el.scrollHeight - el.clientHeight });
      }
    });

    // Scroll each container to bottom, wait, then restore to top
    for (const { el, max } of containers) {
      if (el) {
        el.scrollTop = max;
      } else {
        window.scrollTo(0, max);
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    // Restore everything to top so the page looks normal after extraction
    for (const { el } of containers) {
      if (el) el.scrollTop = 0;
      else     window.scrollTo(0, 0);
    }

    // Small settle wait after restoring scroll
    await new Promise((r) => setTimeout(r, 100));
  });
}

export async function extractPageContext(page: Page): Promise<PageContext> {
  // Scroll through all containers first so off-screen / lazy-rendered
  // elements are added to the DOM before we query them.
  await revealAllElements(page).catch(() => {/* non-fatal */});

  const title = await page.title();
  const url = page.url();
  const dom = await page.content();
  const elements = await page.evaluate(() => {

    // ── Element query ───────────────────────────────────────────────────────────
    const nodes = Array.from(document.querySelectorAll(
      // Standard interactive elements
      'input, button, a, select, textarea, [role="button"], [role="link"], [contenteditable="true"],' +
      // Custom interactive elements — tabindex makes any element keyboard-focusable
      '[tabindex]:not([tabindex="-1"]),' +
      // Custom button/link components that don't use standard tags
      // (e.g. div.bttn-icon-link, span.btn-link used by Angular component libraries)
      '[class*="bttn"], [class*="btn-"],[class*="-btn"],' +
      // Contextual elements — headings, labels, alerts so LLM knows what page/section it is on
      'h1, h2, h3, h4, h5, h6, label, [role="heading"], [role="alert"], [role="status"], [role="alertdialog"]'
    ));

    // Deduplicate DOM nodes (class queries can return the same node multiple times)
    const unique = Array.from(new Set(nodes));

    return unique.map((node, index) => {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      const id = el.getAttribute("id");
      const name = el.getAttribute("name");
      const aria = el.getAttribute("aria-label");
      const placeholder = el.getAttribute("placeholder");
      const rawText = (el.innerText || el.textContent || "").trim();
      // Keep text short for selector use — first 60 chars, no newlines
      const shortText = rawText.replace(/\s+/g, " ").slice(0, 60);

      // ── Selector priority ───────────────────────────────────────────────────
      // 1. Stable attribute selectors  (id, name, aria-label, placeholder)
      // 2. submit/button/reset inputs  — use value attribute as label text
      //    e.g. <input type="submit" value="Next"> → input[value="Next"]
      // 3. Text content fallback       — produces unique, human-readable locators
      //    for custom components that lack stable attributes (e.g. div.bttn-icon-link)
      // 4. Bare tag                    — last resort (will be deduplicated in filter)
      const inputType = el.getAttribute("type")?.toLowerCase();
      const inputValue = (inputType === "submit" || inputType === "button" || inputType === "reset")
        ? el.getAttribute("value") ?? ""
        : "";

      let selector: string;
      if (id)                          selector = `#${id}`;
      else if (name)                   selector = `${tag}[name="${name}"]`;
      else if (aria)                   selector = `${tag}[aria-label="${aria}"]`;
      else if (placeholder)            selector = `${tag}[placeholder="${placeholder}"]`;
      else if (inputValue)             selector = `input[value="${inputValue}"]`;
      else if (shortText)              selector = `text:${shortText}`;
      else                             selector = tag;

      const style = window.getComputedStyle(el);
      const rect  = el.getBoundingClientRect();

      const inputEl     = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const isCheckable = inputType === "radio" || inputType === "checkbox";
      const isValueBearing =
        tag === "select" || tag === "textarea" || (tag === "input" && !isCheckable);

      // For radio/checkbox capture the VALUE attribute (e.g. "Yes"/"No"/"true"/"false")
      // so we can build input[name="X"][value="Y"] selectors.
      const radioValue = isCheckable ? (el as HTMLInputElement).getAttribute("value") ?? undefined : undefined;

      // ── Selector priority ───────────────────────────────────────────────────
      // Angular/framework components often append random numbers to IDs
      // (e.g. "governmentIDToggle94942878874").  Using these IDs means the
      // selector breaks on every new page load.  Detect them and skip.
      const isRandomId = id ? /\d{6,}$/.test(id) : false;

      if (isRandomId) {
        // Prefer name+value for radio/checkbox (most stable), then name alone
        if (isCheckable && name && radioValue)
          selector = `input[name="${name}"][value="${radioValue}"]`;
        else if (name)
          selector = `${tag}[name="${name}"]`;
        else if (aria)
          selector = `${tag}[aria-label="${aria}"]`;
        else if (placeholder)
          selector = `${tag}[placeholder="${placeholder}"]`;
        else if (shortText)
          selector = `text:${shortText}`;
        else
          selector = `#${id}`; // random id as absolute last resort
      } else if (isCheckable && name && radioValue) {
        // Even for non-random IDs, prefer name+value for radio/checkbox —
        // it's more descriptive and survives DOM re-renders
        selector = `input[name="${name}"][value="${radioValue}"]`;
      }
      // else keep selector already set above (id / name / aria / placeholder / text / tag)

      return {
        elementId: `el_${index + 1}`,
        tag,
        text: rawText,
        name,
        idAttr: id,
        placeholder,
        ariaLabel: aria,
        role: el.getAttribute("role"),
        href: el.getAttribute("href"),
        selector,
        visible:
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0,
        enabled: !el.hasAttribute("disabled"),
        ...(isCheckable   && { checked:      (inputEl as HTMLInputElement).checked }),
        ...(isCheckable && radioValue && { radioValue }),
        ...(isValueBearing && (inputEl as HTMLInputElement).value &&
                              { currentValue: (inputEl as HTMLInputElement).value }),
      };
    });
  });

  return { url, title, dom, elements };
}
