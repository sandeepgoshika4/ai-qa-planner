import type { Page } from "playwright";
import type { PageContext } from "../types/pageContext.js";

export async function extractPageContext(page: Page): Promise<PageContext> {
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
      // 2. Text content fallback       — produces unique, human-readable locators
      //    for custom components that lack stable attributes (e.g. div.bttn-icon-link)
      // 3. Bare tag                    — last resort (will be deduplicated in filter)
      let selector: string;
      if (id)                          selector = `#${id}`;
      else if (name)                   selector = `${tag}[name="${name}"]`;
      else if (aria)                   selector = `${tag}[aria-label="${aria}"]`;
      else if (placeholder)            selector = `${tag}[placeholder="${placeholder}"]`;
      else if (shortText)              selector = `text:${shortText}`;
      else                             selector = tag;

      const style = window.getComputedStyle(el);
      const rect  = el.getBoundingClientRect();

      const inputEl     = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const type        = el.getAttribute("type")?.toLowerCase();
      const isCheckable = type === "radio" || type === "checkbox";
      const isValueBearing =
        tag === "select" || tag === "textarea" || (tag === "input" && !isCheckable);

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
        ...(isValueBearing && (inputEl as HTMLInputElement).value &&
                              { currentValue: (inputEl as HTMLInputElement).value }),
      };
    });
  });

  return { url, title, dom, elements };
}
