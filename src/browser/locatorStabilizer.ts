import type { Page } from "playwright";
import { resolveLocator } from "./locatorResolver.js";
import { logInfo } from "../utils/logger.js";

/**
 * Patterns that indicate a selector contains a dynamically generated value
 * that will differ on the next page load.
 *
 * Covers:
 *   - Long digit runs  (#bwc-input-14769808576, #comp-1234567890)
 *   - UUIDs            (#id-3f6a1b2c-4d5e-...)
 *   - Short hash-like  (#el_a3f9b2)
 */
const VOLATILE_PATTERNS = [
  /\d{6,}/,                                           // 6+ consecutive digits
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i,            // UUID segment
  /[0-9a-f]{12,}/i,                                   // long hex string
];

export function isVolatileSelector(selector: string): boolean {
  return VOLATILE_PATTERNS.some((p) => p.test(selector));
}

/**
 * Given a target (CSS selector or semantic locator), tries to return a
 * stable alternative that survives page reloads.
 *
 * Stable attribute priority:
 *   data-testid → data-id → name → aria-label → placeholder
 *   → non-volatile id → tag + stable class → original (fallback)
 *
 * Returns the original target unchanged if it is already stable or if
 * no stable alternative can be found.
 */
export async function toStableSelector(page: Page, target: string): Promise<string> {
  if (!isVolatileSelector(target)) return target;

  try {
    const loc = resolveLocator(page, target).first();

    const stable = await loc.evaluate((el: Element): string | null => {
      const h = el as HTMLElement;

      // 1. data-testid / data-id — intentional test handles
      if (h.dataset.testid)  return `[data-testid="${h.dataset.testid}"]`;
      if (h.dataset.id)      return `[data-id="${h.dataset.id}"]`;

      // 2. name attribute — stable in form controls
      const name = h.getAttribute("name");
      if (name) return `[name="${name}"]`;

      // 3. aria-label — stable accessibility attribute
      const ariaLabel = h.getAttribute("aria-label");
      if (ariaLabel) return `[aria-label="${ariaLabel}"]`;

      // 4. placeholder — stable in inputs
      const placeholder = h.getAttribute("placeholder");
      if (placeholder) return `[placeholder="${placeholder}"]`;

      // 5. Non-volatile id (no 6+ digit run)
      if (h.id && !/\d{6,}/.test(h.id)) return `#${h.id}`;

      // 6. tag + first class that doesn't look generated
      const stableClass = Array.from(h.classList).find(
        (c) => !/\d{4,}/.test(c) && c.length > 2
      );
      if (stableClass) return `${h.tagName.toLowerCase()}.${stableClass}`;

      return null;
    });

    if (stable && stable !== target) {
      logInfo(`[Stabilizer] Volatile "${target}" → stable "${stable}"`);
      return stable;
    }
  } catch {
    // Element may have navigated away — return original
  }

  return target;
}
