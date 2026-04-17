import type { Locator, Page } from "playwright";
import { env } from "../config/env.js";
import type { ElementType, PlannedAction } from "../types/planner.js";
import type { PageElement } from "../types/pageContext.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { resolveLocator } from "./locatorResolver.js";
import { extractPageContext } from "./extractor.js";
import { toStableSelector } from "./locatorStabilizer.js";
import { ActionHealer } from "../agents/actionHealer.js";
import { VisualLocator } from "../agents/visualLocator.js";
import { HumanVerificationRequiredError } from "../errors/humanVerificationError.js";
import { FatalExecutionError, isFatalError, detectPageError } from "../errors/fatalExecutionError.js";
import { detectHumanVerification } from "../detectors/detectHumanVerification.js";

/**
 * Wait for the element to be visible, scroll it into the viewport, then highlight it.
 *
 * The visibility wait handles CONDITIONAL fields — elements that are currently
 * hidden because their visibility depends on another field's value (e.g. a
 * "Spouse Name" input that only appears after selecting Marital Status = Married).
 * The executor plans these actions up-front; this wait lets the page reveal them.
 *
 * Silently ignores all errors so a scroll/highlight failure never blocks the
 * actual interaction that follows.
 */
/** Strip query-string and hash from a URL for loose page-identity comparison. */
function stripQuery(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname; }
  catch { return url; }
}

/**
 * After a click or press, detect whether the page is navigating (URL changed)
 * and, if so, wait for the new page to fully load.
 *
 * For non-navigating clicks (radio, dropdown, accordion) this adds only
 * ~150ms of overhead (one short wait + URL comparison).
 */
async function waitForNavigationIfNeeded(page: Page, urlBefore: string): Promise<void> {
  // Brief pause for browser to start navigation after click
  await page.waitForTimeout(150);

  const urlAfter = page.url();
  if (urlAfter !== urlBefore) {
    // Navigation detected — wait for new page to load
    logInfo(`[Executor] Navigation detected: "${stripQuery(urlBefore)}" → "${stripQuery(urlAfter)}" — waiting for load`);
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    return;
  }

  // URL didn't change yet — listen briefly for a late navigation (form submits)
  try {
    await page.waitForNavigation({ timeout: 300 });
    logInfo(`[Executor] Late navigation detected — waiting for load`);
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  } catch {
    // No navigation within 300ms — non-navigating click, proceed immediately
  }
}

async function scrollAndHighlight(loc: Locator): Promise<void> {
  // Wait up to 8 s for conditional fields to appear after a trigger action.
  // For already-visible elements this resolves instantly.
  await loc.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await loc.highlight().catch(() => {});
}

async function ensureNoHumanVerification(page: Page): Promise<void> {
  const reason = await detectHumanVerification(page);
  if (reason) throw new HumanVerificationRequiredError(reason);
}

// ─── Select option helper ────────────────────────────────────────────────────

/**
 * Robustly select an option from a native <select> or a custom select
 * component (e.g. bss-select, ng-select) that wraps a hidden <select>.
 *
 * Strategy:
 *  1. If the resolved element IS a native <select> — use Playwright selectOption.
 *  2. If it is NOT (e.g. a search <input> injected by the component), walk the
 *     DOM upward to find the closest <select> sibling/ancestor, then set its
 *     value via JavaScript and dispatch change + input events so Angular/Vue/React
 *     picks up the change.
 *  3. Last resort: search every <select> on the page for an option that matches
 *     the desired label or value.
 */
/**
 * Fill an input robustly.
 *
 * Strategy:
 *  1. Try the standard Playwright fill() — works for most plain inputs.
 *  2. If the value didn't stick (masked/date-picker inputs ignore fill),
 *     fall back to click → Ctrl+A → pressSequentially (key-by-key),
 *     then fire Angular-compatible input/change/blur events via JS.
 */
async function robustFill(loc: Locator, value: string): Promise<void> {
  // Attempt 1: standard fill
  await loc.fill(value).catch(() => {});

  const actual = await loc.inputValue().catch(() => "");
  if (actual === value) return; // success — done

  // Attempt 2: masked / Angular input — type character by character
  logInfo(`[Executor] fill() didn't stick (got "${actual}"), falling back to pressSequentially`);
  await loc.click().catch(() => {});
  await loc.page().keyboard.press("Control+a").catch(() => {});
  await loc.pressSequentially(value, { delay: 40 });

  // Fire Angular/React change-detection events
  await loc.evaluate((el) => {
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur",   { bubbles: true }));
  }).catch(() => {});
}

async function robustSelectOption(page: Page, target: string, value: string): Promise<void> {
  const loc = resolveLocator(page, target).first();
  await scrollAndHighlight(loc);

  const tagName = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "unknown");

  if (tagName === "select") {
    // Happy path — native select, use Playwright
    try {
      await loc.selectOption({ label: value }, { timeout: 5000 });
      return;
    } catch {
      await loc.selectOption({ value }, { timeout: 5000 });
      return;
    }
  }

  // The resolved element is NOT a <select> (custom component search input).
  // Use JavaScript to find the real <select> and set the value.
  logInfo(`[Executor] Resolved element is <${tagName}>, not <select> — using JS fallback for selectOption`);

  const selected = await page.evaluate(({ val }) => {
    /**
     * Walk every <select> on the page and find an option whose visible text or
     * value attribute matches `val` (case-insensitive).  When found, set the
     * select's value and fire the events that Angular / other frameworks listen
     * to for model updates.
     */
    const selects = Array.from(document.querySelectorAll("select"));
    for (const sel of selects) {
      const option = Array.from(sel.options).find(
        (o) =>
          o.text.trim().toLowerCase() === val.toLowerCase() ||
          o.value.toLowerCase() === val.toLowerCase() ||
          o.text.trim().toLowerCase().includes(val.toLowerCase())
      );
      if (option) {
        sel.value = option.value;
        // Fire all events Angular / Vue / React / plain JS might listen to
        ["input", "change"].forEach((type) =>
          sel.dispatchEvent(new Event(type, { bubbles: true }))
        );
        return { found: true, usedValue: option.value, label: option.text.trim() };
      }
    }
    return { found: false };
  }, { val: value });

  if (!selected.found) {
    throw new Error(
      `selectOption: could not find option "${value}" in any <select> on the page`
    );
  }

  logInfo(`[Executor] JS selectOption: set value="${selected.usedValue}" (label="${selected.label}")`);
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

// ─── Blind action resolution ────────────────────────────────────────────────

/**
 * Split a string into lower-case word tokens, handling:
 *   - camelCase  →  "incomeSource"    → ["income","source"]
 *   - kebab/snake → "income-source"   → ["income","source"]
 *   - natural    →  "Source of Income" → ["source","income"]  (stop words removed)
 */
function tokenize(str: string): string[] {
  const STOP = new Set([
    "of","the","a","an","is","in","for","and","or","to",
    "by","at","on","with","from","into","as","its","be",
  ]);
  return str
    .replace(/([a-z])([A-Z])/g, "$1 $2")   // camelCase split
    .replace(/[^a-zA-Z0-9]+/g, " ")         // non-alphanumeric → space
    .toLowerCase()
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOP.has(t));
}

/**
 * Return the fraction of tokens in `a` that also appear in `b`.
 * Score is in [0, 1]; 1.0 means all tokens match.
 */
function scoreMatch(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const common = a.filter((t) => setB.has(t)).length;
  return common / Math.max(a.length, b.length);
}

/**
 * Find the PageElement whose attributes best match the human-readable
 * `fieldName` (e.g. "Source of Income" → matches idAttr "incomeSource").
 *
 * Scores all candidates against every attribute using token overlap and
 * returns the best match if its score is ≥ THRESHOLD (0.5 by default).
 */
function findBestMatch(fieldName: string, candidates: PageElement[]): PageElement | null {
  const THRESHOLD = 0.5;
  const fieldTokens = tokenize(fieldName);
  if (fieldTokens.length === 0) return null;

  let best: PageElement | null = null;
  let bestScore = 0;

  for (const e of candidates) {
    const top = Math.max(
      scoreMatch(fieldTokens, tokenize(e.name ?? "")),
      scoreMatch(fieldTokens, tokenize(e.ariaLabel ?? "")),
      scoreMatch(fieldTokens, tokenize(e.placeholder ?? "")),
      scoreMatch(fieldTokens, tokenize(e.text ?? "")),
      scoreMatch(fieldTokens, tokenize(e.idAttr ?? "")),
    );
    if (top > bestScore) {
      bestScore = top;
      best = e;
    }
  }

  return bestScore >= THRESHOLD ? best : null;
}

/**
 * Resolve a blind action's target (a human-readable field name like
 * "Source of Income") into a real CSS selector by re-extracting the live DOM
 * and matching against element attributes using token-based scoring.
 *
 * Returns the matching element's selector, or null if no match found.
 */
async function resolveBlindTarget(
  page: Page,
  fieldName: string,
  elementType?: ElementType
): Promise<string | null> {
  // Re-extract fresh page context — by now earlier actions have executed
  // and the conditional field should be in the DOM.
  const freshCtx = await extractPageContext(page);
  const elements = freshCtx.elements;
  if (!fieldName.trim()) return null;

  // ── Filter candidates by elementType ─────────────────────────────────────
  let candidates = elements.filter((e) => e.visible && e.enabled !== false);

  if (elementType === "radio" || elementType === "checkbox") {
    candidates = candidates.filter((e) =>
      e.tag === "input" || e.role === "radio" || e.role === "checkbox"
    );
  } else if (elementType === "select" || elementType === "dropdown") {
    candidates = candidates.filter((e) =>
      e.tag === "select" || e.role === "combobox" || e.role === "listbox"
    );
  } else if (elementType?.startsWith("input")) {
    candidates = candidates.filter((e) => ["input", "textarea"].includes(e.tag));
  } else if (elementType === "button") {
    candidates = candidates.filter((e) =>
      e.tag === "button" || e.role === "button" || e.tag === "a"
    );
  }

  // ── Token-based best-match across all element attributes ─────────────────
  const match = findBestMatch(fieldName, candidates);

  if (match) {
    const score = Math.max(
      scoreMatch(tokenize(fieldName), tokenize(match.name ?? "")),
      scoreMatch(tokenize(fieldName), tokenize(match.ariaLabel ?? "")),
      scoreMatch(tokenize(fieldName), tokenize(match.placeholder ?? "")),
      scoreMatch(tokenize(fieldName), tokenize(match.text ?? "")),
      scoreMatch(tokenize(fieldName), tokenize(match.idAttr ?? "")),
    );
    logInfo(`[Executor] Blind token-match: "${fieldName}" → "${match.selector}" (score ${(score * 100).toFixed(0)}%)`);
    return match.selector;
  }

  // ── DOM label scan: find <label> whose text matches, then get its input ──
  const labelSelector = await page.evaluate(
    ({ name, elType }) => {
      const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
      const target = normalise(name);

      // Find all labels matching the field name
      const labels = Array.from(document.querySelectorAll("label"));
      for (const label of labels) {
        const text = normalise(label.textContent ?? "");
        if (!text.includes(target) && !target.includes(text)) continue;

        // <label><input>text</label> pattern
        const wrappedInput = label.querySelector("input, select, textarea");
        if (wrappedInput) return buildSelector(wrappedInput as HTMLElement, elType);

        // <label for="id">text</label> pattern
        const forId = label.getAttribute("for");
        if (forId) {
          const linked = document.getElementById(forId);
          if (linked) return buildSelector(linked, elType);
        }

        // Sibling input — label followed by input
        const next = label.nextElementSibling;
        if (next && ["INPUT", "SELECT", "TEXTAREA"].includes(next.tagName)) {
          return buildSelector(next as HTMLElement, elType);
        }

        // Parent contains both label and input
        const parent = label.parentElement;
        if (parent) {
          const input = parent.querySelector("input, select, textarea");
          if (input && input !== label) return buildSelector(input as HTMLElement, elType);
        }
      }
      return null;

      function buildSelector(el: HTMLElement, type: string | undefined): string {
        const tag = el.tagName.toLowerCase();
        const id = el.getAttribute("id");
        const elName = el.getAttribute("name");
        const aria = el.getAttribute("aria-label");
        const placeholder = el.getAttribute("placeholder");
        const inputType = el.getAttribute("type")?.toLowerCase();

        // For radio/checkbox, prefer name+value
        if ((type === "radio" || type === "checkbox") && elName && (el as HTMLInputElement).value) {
          return `input[type="${inputType}"][name="${elName}"][value="${(el as HTMLInputElement).value}"]`;
        }
        if (id && !/\d{6,}$/.test(id)) return `#${id}`;
        if (elName) return `${tag}[name="${elName}"]`;
        if (aria)   return `${tag}[aria-label="${aria}"]`;
        if (placeholder) return `${tag}[placeholder="${placeholder}"]`;
        return tag;
      }
    },
    { name: fieldName, elType: elementType }
  ).catch(() => null);

  return labelSelector;
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
  const visualLocator = new VisualLocator();
  // Work on a shallow-copied array so we can update targets without mutating the original
  const resolved: PlannedAction[] = actions.map((a) => ({ ...a }));

  // Snapshot the page URL + title at the start of this step so we can detect
  // navigation away from the expected context during healing.
  let stepStartUrl   = page.url();
  let stepStartTitle = await page.title().catch(() => "");

  for (let i = 0; i < resolved.length; i++) {
    // Early exits are checked once, outside the heal loop
    if (resolved[i].notes) logInfo(`Planner notes: ${resolved[i].notes}`);
    if (resolved[i].stopExecution) {
      logInfo("Execution stopped by planner due to blocked/unexpected state.");
      return resolved;
    }

    // ── Blind action resolution ───────────────────────────────────────────────
    // When the LLM planned an action for a field not in the page context
    // (conditional/dynamic field), resolve it now against the live DOM.
    if (resolved[i].blind && resolved[i].target) {
      const blindTarget = resolved[i].target!;
      logInfo(`[Executor] Blind action: "${resolved[i].action} → ${blindTarget}" [${resolved[i].elementType ?? "?"}] — resolving against live DOM...`);

      // Step 1: Try to find the element by name/label/aria matching
      const foundSelector = await resolveBlindTarget(page, blindTarget, resolved[i].elementType);

      if (foundSelector) {
        logInfo(`[Executor] Blind resolved: "${blindTarget}" → "${foundSelector}"`);
        resolved[i] = { ...resolved[i], target: foundSelector, blind: false };
      } else {
        // Step 2: Fall back to ActionHealer with fresh page context
        logInfo(`[Executor] Blind target "${blindTarget}" not found by name — calling ActionHealer...`);
        try {
          const freshCtx = await extractPageContext(page);
          const healed = await healer.repairAction(
            resolved[i],
            `Blind action — field "${blindTarget}" was not in page context at plan time. Resolve the correct selector from the current live page.`,
            freshCtx,
            stepDescription,
            resolved.slice(0, i)
          );

          if (healed && healed.action !== "out_of_context" && healed.target) {
            logInfo(`[Executor] Blind healed: "${blindTarget}" → "${healed.target}" [${healed.elementType ?? "?"}]`);
            resolved[i] = { ...healed, blind: false };
          } else {
            logWarn(`[Executor] ActionHealer could not resolve blind target "${blindTarget}" — attempting with original`);
            resolved[i] = { ...resolved[i], blind: false };
          }
        } catch (healErr) {
          logWarn(`[Executor] Blind heal failed: ${(healErr as Error).message} — attempting with original target`);
          resolved[i] = { ...resolved[i], blind: false };
        }
      }
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
        const urlBeforeClick = page.url();

        // When the LLM guesses "text:Log in" for a button, getByText matches
        // headings/labels before the actual button.  Refine to button-scoped
        // selectors when elementType is "button" and the target is a text: selector.
        let clickTarget = action.target;
        if (action.elementType === "button" && action.target.startsWith("text:")) {
          const btnText = action.target.replace(/^text:/, "").trim();
          // Try button:has-text first, then input[value=], then role=button
          const candidates = [
            `button:has-text("${btnText}")`,
            `input[value="${btnText}"]`,
            `[role="button"]:has-text("${btnText}")`,
          ];
          for (const c of candidates) {
            const count = await page.locator(c).count().catch(() => 0);
            if (count > 0) {
              logInfo(`[Executor] Refined button target "${action.target}" → "${c}"`);
              clickTarget = c;
              break;
            }
          }
        }

        // When the LLM picks a text/button selector for a radio/checkbox instead of
        // the actual input selector, find the real input by scanning label text.
        // e.g. button:has-text("INDIVIDUAL (I)") → input[type="radio"][name="accountRelationships"][value="INDV"]
        if (
          (action.elementType === "radio" || action.elementType === "checkbox") &&
          !clickTarget.startsWith("input[") && !clickTarget.startsWith("#")
        ) {
          // Extract the human-readable text from the selector
          let labelText = clickTarget;
          if (labelText.startsWith("text:")) {
            labelText = labelText.replace(/^text:/, "").trim();
          } else if (labelText.startsWith("label:")) {
            labelText = labelText.replace(/^label:/, "").trim();
          } else {
            const hasTextMatch = labelText.match(/:has-text\("([^"]+)"\)/);
            if (hasTextMatch) labelText = hasTextMatch[1];
          }

          const inputType = action.elementType; // "radio" or "checkbox"
          const foundSelector = await page.evaluate(
            ({ text, type }) => {
              const inputs = Array.from(
                document.querySelectorAll<HTMLInputElement>(`input[type="${type}"]`)
              );
              const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
              const target = normalise(text);

              for (const input of inputs) {
                // Check wrapping <label> text
                const label = input.closest("label");
                if (label && normalise(label.textContent ?? "").includes(target)) {
                  return buildSelector(input);
                }
                // Check <label for="id"> text
                if (input.id) {
                  const forLabel = document.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
                  if (forLabel && normalise(forLabel.textContent ?? "").includes(target)) {
                    return buildSelector(input);
                  }
                }
                // Check sibling <span> text (e.g. <label><input><span>text</span></label>)
                const sibling = input.nextElementSibling;
                if (sibling && normalise(sibling.textContent ?? "").includes(target)) {
                  return buildSelector(input);
                }
                // Check parent element text
                const parent = input.parentElement;
                if (parent && normalise(parent.textContent ?? "").includes(target)) {
                  return buildSelector(input);
                }
              }
              return null;

              function buildSelector(el: HTMLInputElement): string {
                if (el.name && el.value) return `input[type="${type}"][name="${el.name}"][value="${el.value}"]`;
                if (el.id) return `#${el.id}`;
                if (el.name) return `input[type="${type}"][name="${el.name}"]`;
                return `input[type="${type}"]`;
              }
            },
            { text: labelText, type: inputType }
          ).catch(() => null);

          if (foundSelector) {
            logInfo(`[Executor] Refined ${inputType} target "${clickTarget}" → "${foundSelector}"`);
            clickTarget = foundSelector;
          }
        }

        const loc = resolveLocator(page, clickTarget).first();
        await scrollAndHighlight(loc);

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
          // Small delay after click for Angular/React change detection to fire
          await page.waitForTimeout(300);
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

        // If the click triggered a page navigation (e.g. "Log in", "Next"),
        // wait for the new page to fully load before proceeding.
        await waitForNavigationIfNeeded(page, urlBeforeClick);
        if (page.url() !== urlBeforeClick) {
          stepStartUrl   = page.url();
          stepStartTitle = await page.title().catch(() => "");
        }

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

      case "selectOption": {
        if (!action.target) throw new Error("selectOption missing target");
        const value = action.valueKey ? dataSet[action.valueKey] : action.value;
        if (value == null) throw new Error("selectOption missing value");

        await robustSelectOption(page, action.target, value);

        resolved[i] = { ...resolved[i], target: await toStableSelector(page, action.target) };
        await ensureNoHumanVerification(page);
        break;
      }

      case "fill": {
        if (!action.target) throw new Error("fill missing target");
        const value = action.valueKey ? dataSet[action.valueKey] : action.value;
        if (value == null) throw new Error("fill missing value");
        const loc = resolveLocator(page, action.target).first();

        // If the target is a <select> element (or marked as select), fill() won't work.
        const tagName = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
        if (tagName === "select" || action.elementType === "select") {
          logInfo(`[Executor] Target is a <select> — switching fill → selectOption for "${action.target}"`);
          await robustSelectOption(page, action.target, value);
          resolved[i] = { ...resolved[i], action: "selectOption", target: await toStableSelector(page, action.target) };
          await ensureNoHumanVerification(page);
          break;
        }

        await scrollAndHighlight(loc);
        await robustFill(loc, value);

        // Stabilize the target AFTER filling (element still in DOM) so the
        // cached selector survives the next page load even if the id is random.
        resolved[i] = { ...resolved[i], target: await toStableSelector(page, action.target) };
        await ensureNoHumanVerification(page);

        // For autocomplete inputs: wait for suggestions, click the matching one,
        // and update the following click action's target with the actual suggestion selector.
        if (action.elementType === "input-autocomplete") {
          const suggestionSelector = await handleAutocomplete(page, value);
          if (suggestionSelector) {
            // Skip the next click/press that confirms the autocomplete selection.
            // The LLM sometimes inserts a "wait" action between the fill and the
            // confirming click — scan ahead past wait actions to find it.
            // IMPORTANT: only skip clicks that look like autocomplete confirmations
            // (elementType "menuitem" or target contains the typed value), NOT
            // unrelated buttons like "Next" / "Continue".
            const waitIndices: number[] = [];
            for (let j = i + 1; j < resolved.length && j <= i + 3; j++) {
              if (resolved[j].action === "wait") {
                waitIndices.push(j);
                continue;
              }
              if (resolved[j].action === "click" || resolved[j].action === "press") {
                const isAutocompleteConfirm =
                  resolved[j].elementType === "menuitem" ||
                  (resolved[j].target?.toLowerCase().includes(value.toLowerCase()) ?? false);
                if (isAutocompleteConfirm) {
                  logInfo(`[Executor] Autocomplete handled — skipping "${resolved[j].action}" action at index ${j}`);
                  resolved[j] = {
                    ...resolved[j],
                    notes: `${resolved[j].notes ?? ""} [auto-handled by autocomplete]`.trim(),
                    _handled: true
                  } as PlannedAction & { _handled?: boolean };
                  // Also mark intermediate wait actions as handled
                  for (const wi of waitIndices) {
                    resolved[wi] = { ...resolved[wi], _handled: true } as PlannedAction & { _handled?: boolean };
                  }
                }
              }
              break; // stop after finding the first non-wait action
            }
          } else {
            logWarn(`[Executor] Autocomplete suggestion for "${value}" not found — proceeding without selection`);
          }
        }
        break;
      }

      case "press": {
        if (!action.target) throw new Error("press missing target");
        const urlBeforePress = page.url();
        const loc = resolveLocator(page, action.target).first();
        await scrollAndHighlight(loc);
        await loc.press(action.value ?? "Enter");
        await ensureNoHumanVerification(page);

        // Stabilize target while element is still reachable
        resolved[i] = { ...resolved[i], target: await toStableSelector(page, action.target) };

        // Press (e.g. Enter on a password field) can trigger form submission / navigation
        await waitForNavigationIfNeeded(page, urlBeforePress);
        if (page.url() !== urlBeforePress) {
          stepStartUrl   = page.url();
          stepStartTitle = await page.title().catch(() => "");
        }
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

        // Handle title: assertions — check page.title() instead of DOM locator.
        // e.g. "title:Home Experience | Wealthscape"
        if (action.target.startsWith("title:")) {
          const expectedTitle = action.target.replace(/^title:/, "").trim();
          await page.waitForFunction(
            (expected) => document.title.includes(expected),
            expectedTitle,
            { timeout: 15000 }
          );
          logInfo(`[Executor] Assert passed — page title contains "${expectedTitle}"`);
          break;
        }

        // Handle url: assertions — check page.url()
        if (action.target.startsWith("url:")) {
          const expectedUrl = action.target.replace(/^url:/, "").trim();
          await page.waitForFunction(
            (expected) => window.location.href.includes(expected),
            expectedUrl,
            { timeout: 15000 }
          );
          logInfo(`[Executor] Assert passed — page URL contains "${expectedUrl}"`);
          break;
        }

        const assertLoc = resolveLocator(page, action.target).first();
        await assertLoc.waitFor({ state: "visible", timeout: 8000 });
        await scrollAndHighlight(assertLoc);
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

        const label = `${action.action}${action.target ? ` -> ${action.target}` : ""}`;

        if (isFatalError(errMsg, pageTitle)) {
          throw new FatalExecutionError(
            `[Fatal] Step failed — system/service error on action "${label}": ${errMsg}`,
            err as Error
          );
        }

        // Check the live DOM for visible system-error / API-failure banners.
        // Angular SPAs render these as components — the page title stays the same
        // even when a "System Error" message is displayed on screen.
        const domError = await detectPageError(page);
        if (domError) {
          throw new FatalExecutionError(
            `[Fatal] System error detected on page while executing "${label}": ${domError}`,
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

        // ── Final heal attempt: try visual locator first ───────────────────────
        if (healAttempt === env.healMaxAttempts && env.visualLocatorEnabled) {
          logInfo(`[VisualLocator] Final heal attempt — trying screenshot-based element location`);
          const visual = await visualLocator.locate(page, resolved[i], stepDescription);

          if (visual?.type === "coordinates") {
            // Click directly at the pixel coordinates identified in the screenshot
            logInfo(`[VisualLocator] Clicking at (${visual.x}, ${visual.y}): ${visual.explanation}`);
            await page.mouse.click(visual.x, visual.y);
            await ensureNoHumanVerification(page);
            resolved[i] = {
              ...resolved[i],
              notes: `${resolved[i].notes ?? ""} [visual locator: clicked at (${visual.x}, ${visual.y})]`.trim()
            };
            break; // Action succeeded — exit the heal-retry loop
          }

          if (visual?.type === "selector") {
            // Swap in the visually-identified selector and retry the action normally
            logInfo(`[VisualLocator] Updating target to visually-identified selector: "${visual.selector}"`);
            resolved[i] = { ...resolved[i], target: visual.selector };
            continue; // Restart the while loop with the new selector
          }

          logWarn(`[VisualLocator] Could not locate element visually — falling back to text healer`);
        }

        // ── Text-based healer ─────────────────────────────────────────────────
        // Capture live page state for the healer
        let freshCtx;
        try { freshCtx = await extractPageContext(page); } catch { throw err; }

        // ── Pre-heal: detect page navigation away from step context ───────────
        // If the URL or title has changed significantly since this step started,
        // the page is out of context — healing would target the wrong page.
        const currentUrl   = page.url();
        const currentTitle = await page.title().catch(() => "");
        const urlChanged   = stripQuery(currentUrl) !== stripQuery(stepStartUrl);
        const titleChanged = stepStartTitle && currentTitle &&
                             currentTitle !== stepStartTitle &&
                             !currentTitle.includes(stepStartTitle) &&
                             !stepStartTitle.includes(currentTitle);

        if (urlChanged || titleChanged) {
          throw new FatalExecutionError(
            `[Out of Context] Page changed during step execution — ` +
            `expected "${stepStartTitle}" (${stripQuery(stepStartUrl)}) ` +
            `but now on "${currentTitle}" (${stripQuery(currentUrl)}). ` +
            `Stopping to avoid executing step on wrong page.`
          );
        }

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

        // ── Post-heal: healer says page doesn't match the step ────────────────
        if (healed.action === "out_of_context") {
          throw new FatalExecutionError(
            `[Out of Context] Healer determined the current page does not match ` +
            `the step context and cannot execute the action. ` +
            `Reason: ${healed.explanation ?? "page context mismatch"}`
          );
        }

        resolved[i] = healed;
        logInfo(`[ActionHealer] Retrying with healed action...`);
        // Loop continues → re-executes resolved[i] with the healed action
      }
    } // end heal-retry while

    // Skip actions that were already handled inline (e.g. autocomplete wait + click)
    while ((resolved[i + 1] as (PlannedAction & { _handled?: boolean }) | undefined)?._handled) {
      logInfo(`[Executor] Skipping next action — already handled inline`);
      i++;
    }

    await page.waitForTimeout(env.stepDelayMs);
  }

  return resolved;
}
