import type { Page } from "playwright";
import { env } from "../config/env.js";
import type { ElementType, PlannedAction } from "../types/planner.js";
import type { PageElement } from "../types/pageContext.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { resolveLocator } from "./locatorResolver.js";
import { extractPageContext } from "./extractor.js";
import { toStableSelector } from "./locatorStabilizer.js";
import { ActionHealer } from "../agents/actionHealer.js";
import { HumanVerificationRequiredError } from "../errors/humanVerificationError.js";
import { FatalExecutionError, isFatalError } from "../errors/fatalExecutionError.js";
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

      // Wait for the suggestion list to disappear — confirms selection was accepted
      const suggestionGone = await page
        .waitForSelector('[role="listbox"], [role="option"]', { state: "hidden", timeout: 2000 })
        .then(() => true)
        .catch(() => false);

      if (!suggestionGone) {
        logWarn("[Executor] Suggestions still visible after click — forcing dismissal");

        // 1. Press Escape — most frameworks close dropdowns on Escape
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);

        const goneAfterEsc = await page
          .waitForSelector('[role="listbox"], [role="option"]', { state: "hidden", timeout: 1000 })
          .then(() => true)
          .catch(() => false);

        if (!goneAfterEsc) {
          // 2. Click somewhere neutral (body) to blur the input and collapse the dropdown
          await page.locator("body").click({ position: { x: 0, y: 0 }, force: true });
          await page.waitForTimeout(300);

          const goneAfterBlur = await page
            .waitForSelector('[role="listbox"], [role="option"]', { state: "hidden", timeout: 1000 })
            .then(() => true)
            .catch(() => false);

          if (!goneAfterBlur) {
            // 3. Last resort — blur the active element via JS
            await page.evaluate(() => {
              const el = document.activeElement as HTMLElement | null;
              el?.blur();
            });
            await page.waitForTimeout(300);
            logWarn("[Executor] Suggestions may still be visible — proceeding anyway");
          } else {
            logInfo("[Executor] Suggestions dismissed via body click");
          }
        } else {
          logInfo("[Executor] Suggestions dismissed via Escape key");
        }
      }

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
 * When an action fails, the ActionHealer is invoked to ask the LLM to repair
 * just that action using the current live page context. Healing is retried up
 * to HEAL_MAX_ATTEMPTS times before the error is re-thrown to the caller.
 *
 * The returned array (including any healed replacements) is suitable for
 * saving back to the plan cache.
 */
export async function executePlannedActions(
  page: Page,
  actions: PlannedAction[],
  dataSet: Record<string, string>,
  stepDescription: string = ""
): Promise<PlannedAction[]> {
  const healer = new ActionHealer();
  // Work on a shallow-copied array so we can update targets without mutating the original
  const resolved: PlannedAction[] = actions.map((a) => ({ ...a }));

  for (let i = 0; i < resolved.length; i++) {
    // Early exits are checked once, outside the heal loop
    if (resolved[i].notes) logInfo(`Planner notes: ${resolved[i].notes}`);
    if (resolved[i].stopExecution) {
      logInfo("Execution stopped by planner due to blocked/unexpected state.");
      return resolved;
    }

    let healAttempt = 0;

    // ── Heal-retry loop ────────────────────────────────────────────────────────
    while (true) {
      const action = resolved[i]; // re-read each attempt — healer may have updated it

      logInfo(
        `Executing action: ${action.action}` +
        `${action.target ? ` -> ${action.target}` : ""}` +
        `${action.elementType ? ` [${action.elementType}]` : ""}` +
        (healAttempt > 0 ? ` (heal attempt ${healAttempt}/${env.healMaxAttempts})` : "")
      );

      try {
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

        // For radio/checkbox: if already in the desired state, skip the click entirely.
        if (action.elementType === "radio" || action.elementType === "checkbox") {
          const alreadyChecked = await loc.evaluate((el) => (el as HTMLInputElement).checked).catch(() => false);
          if (alreadyChecked) {
            logInfo(`[Executor] Skipping click — ${action.elementType} is already checked: ${action.target}`);
            resolved[i] = { ...resolved[i], target: await toStableSelector(page, action.target) };
            break;
          }
        }

        try {
          await loc.click({ timeout: 5000 });
        } catch (clickErr) {
          // Radio/checkbox inputs are often hidden behind a styled <label> or <span>.
          // Try clicking the associated label first, then fall back to force click.
          if (action.elementType === "radio" || action.elementType === "checkbox") {
            const labelClicked = await loc.evaluate((el) => {
              const input = el as HTMLInputElement;
              // Try the <label> that wraps this input
              const label = input.closest("label") ?? document.querySelector(`label[for="${input.id}"]`);
              if (label) { (label as HTMLElement).click(); return true; }
              // Try the parent element
              const parent = input.parentElement;
              if (parent) { parent.click(); return true; }
              return false;
            }).catch(() => false);

            if (!labelClicked) {
              // Last resort: force click ignoring pointer-events interception
              await loc.click({ force: true });
            }
          } else {
            throw clickErr; // non-radio/checkbox click failure — let healer handle it
          }
        }

        await ensureNoHumanVerification(page);

        // Stabilize own target before caching
        resolved[i] = { ...resolved[i], target: await toStableSelector(page, action.target) };

        // After clicking an accordion, tab, or dropdown, new elements appear.
        // Resolve + stabilize the NEXT action's target in the fresh context.
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
              const stableFound = await toStableSelector(page, found);
              logInfo(`[Executor] Resolved dynamic target "${next.target}" → "${stableFound}"`);
              resolved[i + 1] = { ...next, target: stableFound };
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

        await loc.highlight();
        await loc.fill(value);

        // Stabilize the target AFTER filling (element still in DOM) so the
        // cached selector survives the next page load even if the id is random.
        resolved[i] = { ...resolved[i], target: await toStableSelector(page, action.target) };
        await ensureNoHumanVerification(page);

        // For autocomplete inputs: wait for suggestions, click the matching one,
        // and update the following click action's target with the actual suggestion selector.
        if (action.elementType === "input-autocomplete") {
          const suggestionSelector = await handleAutocomplete(page, value);
          if (suggestionSelector) {
            // Skip the next action if it's a click or press that was the LLM's
            // strategy for confirming the autocomplete (now handled inline).
            if (i + 1 < resolved.length &&
                (resolved[i + 1].action === "click" || resolved[i + 1].action === "press")) {
              logInfo(`[Executor] Autocomplete handled — skipping next "${resolved[i + 1].action}" action`);
              resolved[i + 1] = {
                ...resolved[i + 1],
                notes: `${resolved[i + 1].notes ?? ""} [auto-handled by autocomplete]`.trim(),
                _handled: true
              } as PlannedAction & { _handled?: boolean };
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

        // Stabilize target while element is still reachable
        resolved[i] = { ...resolved[i], target: await toStableSelector(page, action.target) };
        break;
      }

      case "wait":
        await page.waitForTimeout(Number(action.value ?? env.stepDelayMs));
        break;

      case "assert": {
        if (!action.target) {
          logWarn(`[Executor] Skipping assert — LLM generated no target (elementType: ${action.elementType ?? "unknown"}). Update the prompt or re-run to regenerate the plan.`);
          break;
        }
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

        // ── Action succeeded — exit the heal loop ────────────────────────────
        break;

      } catch (err) {
        // Human verification must never be swallowed — let runner handle it
        if (err instanceof HumanVerificationRequiredError) throw err;

        // Fatal errors (HTTP 4xx/5xx, network down, service errors) cannot be
        // repaired by replanning — fail immediately without healing.
        const errMsg = (err as Error).message;
        let pageTitle: string | undefined;
        try { pageTitle = await page.title(); } catch { /* ignore */ }

        if (isFatalError(errMsg, pageTitle)) {
          const label = `${action.action}${action.target ? ` -> ${action.target}` : ""}`;
          throw new FatalExecutionError(
            `[Fatal] Step failed — system/service error on action "${label}": ${errMsg}`,
            err as Error
          );
        }

        healAttempt++;

        logWarn(
          `[ActionHealer] Action failed: "${errMsg}"` +
          (healAttempt <= env.healMaxAttempts
            ? ` — starting heal attempt ${healAttempt}/${env.healMaxAttempts}`
            : " — all heal attempts exhausted")
        );

        if (healAttempt > env.healMaxAttempts) throw err;

        // Capture live page state for the healer
        let freshCtx;
        try { freshCtx = await extractPageContext(page); } catch { throw err; }

        const healed = await healer.repairAction(
          resolved[i],
          errMsg,
          freshCtx,
          stepDescription,
          resolved.slice(0, i)   // actions already completed
        );

        if (!healed) {
          logWarn("[ActionHealer] LLM could not produce a repair — re-throwing");
          throw err;
        }

        resolved[i] = healed;
        logInfo(`[ActionHealer] Retrying with healed action...`);
        // Loop continues → re-executes resolved[i] with the healed action
      }
    } // end heal-retry while

    // Skip actions that were already handled inline (e.g. autocomplete click)
    if ((resolved[i + 1] as (PlannedAction & { _handled?: boolean }) | undefined)?._handled) {
      logInfo(`[Executor] Skipping next action — already handled inline`);
      i++;
    }

    await page.waitForTimeout(env.stepDelayMs);
  }

  return resolved;
}
