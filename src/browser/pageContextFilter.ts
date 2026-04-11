/**
 * pageContextFilter.ts
 *
 * Reduces a raw PageContext to a compact PlannerContext before it is
 * serialised into an LLM prompt. The goal is to maximise signal and
 * minimise token count.
 *
 * Elements are split into two independent tiers so contextual elements
 * never displace actionable ones:
 *
 *  TIER 1 — Interactive (capped at MAX_PLANNER_ELEMENTS, default 60)
 *    inputs, buttons, selects, textareas, links, checkboxes, radios …
 *    Sorted by interaction priority: inputs first, links last.
 *
 *  TIER 2 — Contextual (capped at MAX_CONTEXT_ELEMENTS, default 20)
 *    headings (h1–h6), labels, alerts, status messages, validation errors.
 *    These tell the LLM WHAT PAGE / SECTION it is on and what each field
 *    is called — without them the LLM has no situational awareness.
 *
 *  TIER 3 — Conditional (capped at MAX_CONDITIONAL_ELEMENTS, default 20)
 *    Hidden-but-interactive elements whose visibility depends on other fields.
 *    Examples: "Spouse Name" appears only when "Married" is selected,
 *    "Tax ID" appears only when a specific account type is chosen.
 *    Sent with visible:false so the LLM knows these exist but are not yet
 *    rendered — it should still plan actions for them and the executor will
 *    wait for them to appear before interacting.
 *
 * All tiers are deduplicated. The raw DOM string is always excluded.
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
  /** "interactive" elements can be targeted by actions; "context" elements provide page awareness. */
  kind: "interactive" | "context";
  text?: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  role?: string;
  href?: string;
  checked?: boolean;
  currentValue?: string;
  /** Present and false when element is natively disabled — LLM should not target it. */
  enabled?: false;
  /**
   * Present and false when element is currently hidden but will appear after
   * interacting with a trigger field (conditional / dependent field).
   * The executor will wait for it to become visible before interacting.
   */
  visible?: false;
}

/**
 * Slimmed-down page context sent in every LLM planning call.
 * Notably does NOT include the raw DOM — it's too large and not needed.
 */
export interface PlannerContext {
  url: string;
  title: string;
  elements: PlannerElement[];
  _stats: {
    totalExtracted: number;
    interactiveSent: number;
    contextSent: number;
    conditionalSent: number;
    totalSent: number;
  };
}

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_INTERACTIVE_ELEMENTS  = env.maxPlannerElements;   // default 60
const MAX_CONTEXT_ELEMENTS      = 20;                        // headings, labels, alerts
const MAX_CONDITIONAL_ELEMENTS  = 20;                        // hidden fields that appear on change
const MAX_TEXT_LENGTH           = 80;                        // chars before truncation

// ─── Tier 1: Interactive ──────────────────────────────────────────────────────

const INTERACTIVE_TAGS = new Set([
  "input", "button", "a", "select", "textarea", "option"
]);

const INTERACTIVE_ROLES = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "checkbox", "radio", "combobox", "listbox", "option",
  "switch", "treeitem", "spinbutton", "searchbox", "textbox"
]);

function isInteractive(el: PageElement): boolean {
  // Only require visibility — NOT enabled. Angular and custom components often
  // omit the native `disabled` HTML attribute in favour of CSS classes or
  // aria-disabled, so our enabled flag would incorrectly exclude them.
  // The LLM also benefits from knowing about disabled elements
  // (e.g. "Next is disabled because a required field is empty").
  if (!el.visible) return false;
  if (INTERACTIVE_TAGS.has(el.tag)) return true;
  if (el.role && INTERACTIVE_ROLES.has(el.role.toLowerCase())) return true;
  return false;
}

/**
 * Lower number = higher priority = sent first when the list is capped.
 * Inputs are most likely to be targeted; decorative links are least.
 */
function interactivePriority(el: PageElement): number {
  const tag = el.tag;
  if (tag === "input")    return 1;
  if (tag === "textarea") return 2;
  if (tag === "select")   return 2;
  if (tag === "button")   return 3;
  if (tag === "option")   return 3;
  if (el.role) {
    const r = el.role.toLowerCase();
    if (r === "textbox" || r === "searchbox" || r === "spinbutton") return 2;
    if (r === "button")  return 3;
    if (r === "combobox" || r === "listbox" || r === "option")      return 3;
    if (r === "tab")     return 4;
    if (r === "checkbox" || r === "radio" || r === "switch")        return 5;
    if (r === "menuitem" || r === "menuitemcheckbox" || r === "menuitemradio") return 4;
    return 6;
  }
  if (tag === "a") return 7;
  return 8;
}

// ─── Tier 2: Contextual ───────────────────────────────────────────────────────

/**
 * HTML tags that carry important page-context information but are NOT
 * directly actionable by Playwright actions.
 *
 * Headings  → "You are on the Account Details page"
 * Labels    → "This input is for Mobile Phone Number"
 * Alerts    → validation errors, success banners, warning toasts
 */
const CONTEXT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "label"]);

const CONTEXT_ROLES = new Set([
  "heading", "label",
  "alert", "alertdialog", "status",  // error messages, toasts
  "banner", "complementary",          // page region headings
]);

function isContextual(el: PageElement): boolean {
  if (!el.visible) return false;           // hidden headings add no value
  if (!el.text?.trim()) return false;      // blank heading/label is useless
  if (CONTEXT_TAGS.has(el.tag)) return true;
  if (el.role && CONTEXT_ROLES.has(el.role.toLowerCase())) return true;
  return false;
}

// ─── Tier 3: Conditional (hidden dependent fields) ────────────────────────────

/**
 * Returns true for elements that are currently HIDDEN but are interactive and
 * have enough identity to be useful in a plan.
 *
 * These are fields whose visibility is controlled by another field — e.g.
 * "Spouse DOB" only shows when Marital Status = Married.
 *
 * Excluded from this tier:
 *   - Elements already in Tier 1 (visible interactive)
 *   - Disabled elements (permanently unavailable)
 *   - Elements with no selector attributes or text (unidentifiable)
 *   - type="hidden" native inputs (never shown to user)
 */
function isConditional(el: PageElement): boolean {
  if (el.visible)   return false;  // already in Tier 1
  if (!el.enabled)  return false;  // permanently disabled, not conditional
  // Must be an interactive element type
  if (!INTERACTIVE_TAGS.has(el.tag) &&
      !(el.role && INTERACTIVE_ROLES.has(el.role.toLowerCase()))) return false;
  // Must have at least one identifying attribute so the LLM can reference it
  const hasIdentity = !!(el.idAttr || el.name || el.ariaLabel || el.placeholder || el.text?.trim());
  if (!hasIdentity) return false;
  return true;
}

// ─── Field shaping ────────────────────────────────────────────────────────────

function toPlannedElement(el: PageElement, kind: "interactive" | "context", hidden = false): PlannerElement {
  const out: PlannerElement = { tag: el.tag, selector: el.selector, kind };

  const text = el.text?.trim();
  if (text) out.text = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + "…" : text;

  if (el.name)        out.name        = el.name;
  if (el.placeholder) out.placeholder = el.placeholder;
  if (el.ariaLabel)   out.ariaLabel   = el.ariaLabel;
  if (el.role)        out.role        = el.role;
  if (el.href)        out.href        = el.href;

  if (el.checked !== undefined) out.checked      = el.checked;
  if (el.currentValue)          out.currentValue = el.currentValue;
  // Only flag when explicitly disabled — absence means enabled (saves tokens)
  if (!el.enabled)              out.enabled      = false;
  // Flag conditional hidden fields — executor will wait for them to appear
  if (hidden)                   out.visible      = false;

  return out;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Convert a raw `PageContext` into a compact `PlannerContext`.
 *
 * @param ctx             Raw page context from `extractPageContext()`.
 * @param interactiveLimit Override the interactive element cap (useful for healers).
 */
export function filterPageContext(
  ctx: PageContext,
  interactiveLimit: number = MAX_INTERACTIVE_ELEMENTS
): PlannerContext {
  const total = ctx.elements.length;
  const seenSelectors = new Set<string>();

  // ── Tier 1: Interactive ──────────────────────────────────────────────────────
  const interactive = ctx.elements
    .filter(isInteractive)
    .sort((a, b) => interactivePriority(a) - interactivePriority(b))
    .filter((el) => {
      if (seenSelectors.has(el.selector)) return false;
      seenSelectors.add(el.selector);
      return true;
    })
    .slice(0, interactiveLimit)
    .map((el) => toPlannedElement(el, "interactive"));

  // ── Tier 2: Contextual ───────────────────────────────────────────────────────
  // Uses the same seenSelectors set to avoid duplicating any element that is
  // also in the interactive tier (e.g. a <label> that wraps a <button>).
  const contextual = ctx.elements
    .filter(isContextual)
    .filter((el) => {
      if (seenSelectors.has(el.selector)) return false;
      seenSelectors.add(el.selector);
      return true;
    })
    .slice(0, MAX_CONTEXT_ELEMENTS)
    .map((el) => toPlannedElement(el, "context"));

  // ── Tier 3: Conditional (hidden dependent fields) ────────────────────────────
  // Fields currently hidden but expected to appear after a trigger interaction.
  // Sorted same as interactive so highest-value hidden fields come first.
  const conditional = ctx.elements
    .filter(isConditional)
    .sort((a, b) => interactivePriority(a) - interactivePriority(b))
    .filter((el) => {
      if (seenSelectors.has(el.selector)) return false;
      seenSelectors.add(el.selector);
      return true;
    })
    .slice(0, MAX_CONDITIONAL_ELEMENTS)
    .map((el) => toPlannedElement(el, "interactive", /* hidden */ true));

  // ── Combine: interactive → context → conditional ─────────────────────────────
  const elements = [...interactive, ...contextual, ...conditional];

  return {
    url: ctx.url,
    title: ctx.title,
    elements,
    _stats: {
      totalExtracted:   total,
      interactiveSent:  interactive.length,
      contextSent:      contextual.length,
      conditionalSent:  conditional.length,
      totalSent:        elements.length
    }
  };
}
