import type { Page } from "playwright";
import { env } from "../config/env.js";
import type { ElementType, PlannedAction } from "../types/planner.js";
import type { PageElement } from "../types/pageContext.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { resolveLocator } from "./locatorResolver.js";
import { extractPageContext } from "./extractor.js";
import { HumanVerificationRequiredError } from "../errors/humanVerificationError.js";
import { detectHumanVerification } from "../detectors/detectHumanVerification.js";

async function ensureNoHumanVerification(page: Page): Promise<void> {
  const reason = await detectHumanVerification(page);
  if (reason) throw new HumanVerificationRequiredError(reason);
}

// ─── Dynamic element discovery ───────────────────────────────────────────────

/**
 * Wait for the page to settle after an interaction, then extract fresh context.
 * Tries networkidle briefly so API-driven content (autocomplete, lazy tables)
 * is included — falls back gracefully if the page never fully idles.
 */
async function settleAndExtract(page: Page): Promise<PageElement[]> {
  await page.waitForTimeout(env.stepDelayMs);
  try {
    await page.waitForLoadState("networkidle", { timeout: 3000 });
  } catch {
    // Page didn't reach networkidle — use whatever is loaded
  }
  const ctx = await extractPageContext(page);
  return ctx.elements;
}

/**
 * Search freshly extracted page elements for the best match for a semantic
 * target string, optionally narrowed by elementType.
 *
 * Returns the element's CSS selector if found, or null.
 * Does NOT attempt to re-resolve CSS/XPath selectors — those go straight
 * to Playwright's locator engine.
 */
function findInElements(
  elements: PageElement[],
  target: string,
  elementType?: ElementType
): string | null {
  // If the target is already a CSS/attribute selector, skip text search
  // and let resolveLocator handle it directly.
  const isSemantic =
    target.startsWith("text:") ||
    target.startsWith("role:") ||
    target.startsWith("label:") ||
    target.startsWith("placeholder:");

  if (!isSemantic) return null;

  // Extract the human-readable search term from the semantic prefix
  let searchTerm = target;
  if (target.startsWith("text:"))        searchTerm = target.slice(5);
  else if (target.startsWith("role:"))   searchTerm = target.split("|")[1] ?? "";
  else if (target.startsWith("label:"))  searchTerm = target.slice(6);
  else if (target.startsWith("placeholder:")) searchTerm = target.slice(12);

  const lower = searchTerm.toLowerCase().trim();
  if (!lower) return null;

  // Start with visible, enabled elements then narrow by elementType hint
  let candidates = elements.filter((e) => e.visible && e.enabled !== false);

  if (elementType === "button") {
    candidates = candidates.filter((e) => e.tag === "button" || e.role === "button");
  } else if (elementType === "link") {
    candidates = candidates.filter((e) => e.tag === "a");
  } else if (elementType === "menuitem") {
    candidates = candidates.filter((e) =>
      ["a", "li", "button"].includes(e.tag) ||
      ["menuitem", "menuitemradio", "menuitemcheckbox", "option"].includes(e.role ?? "")
    );
  } else if (elementType === "tab") {
    candidates = candidates.filter((e) => e.role === "tab" || e.tag === "button");
  } else if (elementType === "accordion") {
    candidates = candidates.filter((e) =>
      ["button", "summary", "h1", "h2", "h3", "h4"].includes(e.tag) ||
      e.role === "button"
    );
  } else if (elementType?.startsWith("input")) {
    candidates = candidates.filter((e) => ["input", "textarea"].includes(e.tag));
  } else if (elementType === "select") {
    candidates = candidates.filter((e) => e.tag === "select");
  }

  const match = candidates.find(
    (e) =>
      e.text?.toLowerCase().includes(lower) ||
      (e.ariaLabel ?? "").toLowerCase().includes(lower) ||
      (e.name ?? "").toLowerCase().includes(lower) ||
      (e.placeholder ?? "").toLowerCase().includes(lower)
  );

  return match?.selector ?? null;
}

/**
 * After filling an input-autocomplete, wait for suggestions to appear and
 * click the one that matches the filled value.
 * Returns the selector of the suggestion that was clicked, or null if none found.
 */
async function handleAutocomplete(page: Page, fillValue: string): Promise<string | null> {
  // Wait for the suggestion list to appear
  const suggestionSelectors = [
    `[role="option"]:visible`,
    `[role="listbox"] [role="option"]:visible`,
    `[role="listbox"] li:visible`,
    `ul.suggestions li:visible`,
    `ul.autocomplete li:visible`,
  ];

  let foundSelector: string | null = null;

  for (const sel of suggestionSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 3000 });
      foundSelector = sel;
      break;
    } catch {
      // Try next pattern
    }
  }

  if (!foundSelector) {
    // Fall back to scanning fresh context for any option/listitem matching the value
    const elements = await settleAndExtract(page);
    const lower = fillValue.toLowerCase();
    const match = elements.find(
      (e) =>
        e.visible &&
        ["option", "listbox"].includes(e.role ?? "") === false &&
        ["li", "div"].includes(e.tag) &&
        e.text?.toLowerCase().includes(lower)
    );
    if (!match) return null;
    foundSelector = match.selector;
  }

  // Try to click the suggestion whose text matches the fill value
  try {
    const option = page
      .locator(`[role="option"], [role="listbox"] li, ul li`)
      .filter({ hasText: new RegExp(fillValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") })
      .first();

    const visible = await option.isVisible().catch(() => false);
    if (visible) {
      const selector = await option.evaluate((el) => {
        // Build a best-effort unique selector to store in the cache
        if (el.id) return `#${el.id}`;
        if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;
        return el.tagName.toLowerCase() + (el.className ? `.${el.className.trim().split(/\s+/)[0]}` : "");
      }).catch(() => foundSelector as string);

      await option.highlight().catch(() => {});
      await option.click();
      logInfo(`[Executor] Autocomplete: selected suggestion "${fillValue}" via ${selector}`);
      return selector;
    }
  } catch {
    // Could not click suggestion
  }

  return null;
}

// ─── Main executor ────────────────────────────────────────────────────────────

/**
 * Execute planned actions and return a copy with targets resolved to actual
 * CSS selectors discovered at runtime.
 *
 * The returned array is suitable for saving back to the plan cache so future
 * runs skip dynamic discovery entirely.
 */
export async function executePlannedActions(
  page: Page,
  actions: PlannedAction[],
  dataSet: Record<string, string>
): Promise<PlannedAction[]> {
  // Work on a shallow-copied array so we can update targets without mutating the original
  const resolved: PlannedAction[] = actions.map((a) => ({ ...a }));

  for (let i = 0; i < resolved.length; i++) {
    const action = resolved[i];

    if (action.notes) logInfo(`Planner notes: ${action.notes}`);

    if (action.stopExecution) {
      logInfo("Execution stopped by planner due to blocked/unexpected state.");
      return resolved;
    }

    logInfo(
      `Executing action: ${action.action}` +
      `${action.target ? ` -> ${action.target}` : ""}` +
      `${action.elementType ? ` [${action.elementType}]` : ""}`
    );

    switch (action.action) {
      case "goto": {
        const url = action.valueKey ? dataSet[action.valueKey] : action.value;
        if (!url) throw new Error("Missing URL");
        await page.goto(url, { waitUntil: "networkidle" });
        await ensureNoHumanVerification(page);
        break;
      }

      case "click": {
        if (!action.target) throw new Error("click missing target");
        const loc = resolveLocator(page, action.target).first();
        await loc.highlight();
        await loc.click();
        await ensureNoHumanVerification(page);

        // After clicking an accordion, tab, or dropdown, new elements appear.
        // Try to resolve the NEXT action's target in the fresh context so we
        // can store the exact locator in the cache.
        const triggersReveal =
          action.elementType === "accordion" ||
          action.elementType === "tab" ||
          action.elementType === "dropdown" ||
          action.elementType === "menuitem";

        if (triggersReveal && i + 1 < resolved.length) {
          const next = resolved[i + 1];
          if (next.target) {
            const elements = await settleAndExtract(page);
            const found = findInElements(elements, next.target, next.elementType);
            if (found) {
              logInfo(`[Executor] Resolved dynamic target "${next.target}" → "${found}"`);
              resolved[i + 1] = { ...next, target: found };
            } else {
              logWarn(`[Executor] Could not find "${next.target}" after ${action.elementType} click — will attempt with original target`);
            }
          }
        }
        break;
      }

      case "fill": {
        if (!action.target) throw new Error("fill missing target");
        const value = action.valueKey ? dataSet[action.valueKey] : action.value;
        if (value == null) throw new Error("fill missing value");
        const loc = resolveLocator(page, action.target).first();

        // Store the actual resolved selector for caching
        const resolvedSelector = await loc.evaluate((el) => {
          if (el.id) return `#${el.id}`;
          if (el.getAttribute("name")) return `[name="${el.getAttribute("name")}"]`;
          if (el.getAttribute("placeholder")) return `[placeholder="${el.getAttribute("placeholder")}"]`;
          return el.tagName.toLowerCase();
        }).catch(() => action.target as string);

        if (resolvedSelector !== action.target) {
          resolved[i] = { ...action, target: resolvedSelector };
        }

        await loc.highlight();
        await loc.fill(value);
        await ensureNoHumanVerification(page);

        // For autocomplete inputs: wait for suggestions, click the matching one,
        // and update the following click action's target with the actual suggestion selector.
        if (action.elementType === "input-autocomplete") {
          const suggestionSelector = await handleAutocomplete(page, value);
          if (suggestionSelector) {
            // If the next action is a click targeting the same suggestion, update it.
            if (i + 1 < resolved.length && resolved[i + 1].action === "click") {
              logInfo(`[Executor] Autocomplete handled — updating next click target to "${suggestionSelector}"`);
              resolved[i + 1] = { ...resolved[i + 1], target: suggestionSelector };
              // Mark as already executed so the loop skips it
              resolved[i + 1] = { ...resolved[i + 1], notes: `${resolved[i + 1].notes ?? ""} [auto-handled by autocomplete]`.trim(), _handled: true } as PlannedAction & { _handled?: boolean };
            }
          } else {
            logWarn(`[Executor] Autocomplete suggestion for "${value}" not found — proceeding without selection`);
          }
        }
        break;
      }

      case "press": {
        if (!action.target) throw new Error("press missing target");
        const loc = resolveLocator(page, action.target).first();
        await loc.highlight();
        await loc.press(action.value ?? "Enter");
        await ensureNoHumanVerification(page);
        break;
      }

      case "wait":
        await page.waitForTimeout(Number(action.value ?? env.stepDelayMs));
        break;

      case "assert": {
        if (!action.target) throw new Error("assert missing target");
        await resolveLocator(page, action.target).first().waitFor({
          state: "visible",
          timeout: 8000
        });
        await ensureNoHumanVerification(page);
        break;
      }

      case "done":
        return resolved;
    }

    // Skip actions that were already handled inline (e.g. autocomplete click)
    if ((resolved[i + 1] as (PlannedAction & { _handled?: boolean }) | undefined)?._handled) {
      logInfo(`[Executor] Skipping next action — already handled inline`);
      i++;
    }

    await page.waitForTimeout(env.stepDelayMs);
  }

  return resolved;
}
