/**
 * pageContextFilter.ts
 *
 * Reduces a raw PageContext to a compact PlannerContext before it is
 * serialised into an LLM prompt. The goal is to maximise signal and
 * minimise token count by:
 *
 *  1. Keeping only visible, enabled elements.
 *  2. Keeping only interactive tags / ARIA roles relevant to automation.
 *  3. Removing non-interactive input types (hidden).
 *  4. Deduplicating elements with identical selectors.
 *  5. Stripping internal / redundant fields (elementId, visible, enabled).
 *  6. Omitting null / undefined / empty-string fields.
 *  7. Truncating long text values.
 *  8. Sorting by interaction priority (inputs > buttons > selects > links …).
 *  9. Capping total elements at MAX_PLANNER_ELEMENTS.
 * 10. Omitting the raw DOM string (too large, not needed for planning).
 */

import type { PageContext, PageElement } from "../types/pageContext.js";
import { env } from "../config/env.js";

// ─── Output types ─────────────────────────────────────────────────────────────

/**
 * Compact element shape sent to the LLM.
 * All optional fields are omitted when falsy so JSON stays small.
 */
export interface PlannerElement {
  tag: string;
  selector: string;
  text?: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  role?: string;
  href?: string;
  checked?: boolean;
  currentValue?: string;
}

/**
 * Slimmed-down page context sent in every LLM planning call.
 * Notably does NOT include the raw DOM — it's too large and not needed.
 */
export interface PlannerContext {
  url: string;
  title: string;
  elements: PlannerElement[];
  /** Token-saving summary so the LLM understands how many elements were omitted. */
  _stats: {
    totalExtracted: number;
    visibleInteractive: number;
    sentToLlm: number;
  };
}

// ─── Configuration ────────────────────────────────────────────────────────────

/** Maximum number of elements to include in the LLM prompt. */
const MAX_PLANNER_ELEMENTS = env.maxPlannerElements;

/** Maximum characters kept from an element's text content. */
const MAX_TEXT_LENGTH = 80;

// ─── Rules ────────────────────────────────────────────────────────────────────

/**
 * HTML tags whose elements are always potentially relevant to automation.
 */
const INTERACTIVE_TAGS = new Set([
  "input", "button", "a", "select", "textarea", "option"
]);

/**
 * ARIA roles that make any element interactive / targetable.
 */
const INTERACTIVE_ROLES = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "checkbox", "radio", "combobox", "listbox", "option",
  "switch", "treeitem", "spinbutton", "searchbox", "textbox"
]);

/**
 * Input types that are invisible and never actionable by automation.
 */
const SKIP_INPUT_TYPES = new Set(["hidden"]);

// ─── Priority scoring ─────────────────────────────────────────────────────────

/**
 * Lower score = higher priority = sent first when the list is capped.
 *
 * Ordering rationale:
 *   Text/password/email inputs  → most commonly targeted in test steps
 *   Selects / textareas         → form controls
 *   Buttons                     → actions / submissions
 *   Radio / checkbox            → toggles
 *   Links                       → navigation, less often targeted directly
 *   Roles (generic)             → catch-all interactive elements
 */
function interactionPriority(el: PageElement): number {
  const tag = el.tag;

  if (tag === "input") {
    const type = (el.name ?? "").toLowerCase(); // type is inferred from name pattern
    if (type.includes("password"))  return 1;
    if (type.includes("radio"))     return 5;
    if (type.includes("checkbox"))  return 5;
    return 1; // text / email / tel / number / search / date …
  }

  if (tag === "textarea") return 2;
  if (tag === "select")   return 2;
  if (tag === "button")   return 3;
  if (tag === "option")   return 3;

  if (el.role) {
    const r = el.role.toLowerCase();
    if (r === "textbox" || r === "searchbox" || r === "spinbutton") return 2;
    if (r === "button")  return 3;
    if (r === "combobox" || r === "listbox" || r === "option")      return 3;
    if (r === "checkbox" || r === "radio" || r === "switch")        return 5;
    if (r === "tab")     return 4;
    if (r === "menuitem" || r === "menuitemcheckbox" || r === "menuitemradio") return 4;
    return 6;
  }

  if (tag === "a") return 7; // links are lowest priority
  return 8;
}

// ─── Filter predicates ────────────────────────────────────────────────────────

function isVisible(el: PageElement): boolean {
  return el.visible;
}

function isEnabled(el: PageElement): boolean {
  return el.enabled;
}

function isInteractive(el: PageElement): boolean {
  const tag = el.tag;

  // Explicitly non-interactive input types
  if (tag === "input") {
    // We don't have `type` in PageElement, but hidden inputs are never enabled+visible
    // Extra guard: skip if the selector looks like a hidden input
    if (SKIP_INPUT_TYPES.has(el.idAttr ?? "")) return false;
    return true;
  }

  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (el.role && INTERACTIVE_ROLES.has(el.role.toLowerCase())) return true;

  return false;
}

// ─── Field shaping ────────────────────────────────────────────────────────────

/**
 * Build a compact PlannerElement, omitting all falsy fields to keep JSON lean.
 */
function toPlannedElement(el: PageElement): PlannerElement {
  const out: PlannerElement = {
    tag: el.tag,
    selector: el.selector
  };

  // Truncate long text
  const text = el.text?.trim();
  if (text) out.text = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + "…" : text;

  if (el.name)        out.name        = el.name;
  if (el.placeholder) out.placeholder = el.placeholder;
  if (el.ariaLabel)   out.ariaLabel   = el.ariaLabel;
  if (el.role)        out.role        = el.role;
  if (el.href)        out.href        = el.href;

  // State fields — only include when meaningful
  if (el.checked !== undefined) out.checked = el.checked;
  if (el.currentValue)          out.currentValue = el.currentValue;

  return out;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Convert a raw `PageContext` into a compact `PlannerContext` suitable for
 * inclusion in an LLM prompt.
 *
 * @param ctx   Raw page context from `extractPageContext()`.
 * @param limit Override the default element cap (useful for healers that need fewer).
 */
export function filterPageContext(ctx: PageContext, limit: number = MAX_PLANNER_ELEMENTS): PlannerContext {
  const total = ctx.elements.length;

  // Step 1: visible + enabled + interactive only
  const interactive = ctx.elements.filter(
    (el) => isVisible(el) && isEnabled(el) && isInteractive(el)
  );

  // Step 2: deduplicate by selector (keep first occurrence)
  const seenSelectors = new Set<string>();
  const deduped = interactive.filter((el) => {
    if (seenSelectors.has(el.selector)) return false;
    seenSelectors.add(el.selector);
    return true;
  });

  // Step 3: sort by interaction priority (most-useful elements first)
  deduped.sort((a, b) => interactionPriority(a) - interactionPriority(b));

  // Step 4: cap total elements
  const capped = deduped.slice(0, limit);

  // Step 5: shape each element into a compact object
  const elements = capped.map(toPlannedElement);

  return {
    url: ctx.url,
    title: ctx.title,
    // DOM is intentionally excluded — too large and not needed for planning
    elements,
    _stats: {
      totalExtracted:    total,
      visibleInteractive: deduped.length,
      sentToLlm:         elements.length
    }
  };
}
