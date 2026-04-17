import path from "node:path";
import fs from "node:fs/promises";
import type { Frame, Page } from "playwright";
import { extractPageContext } from "./extractor.js";
import type { PageContext } from "../types/pageContext.js";
import type { ManualTestStep } from "../types/manualTest.js";
import type { StepResult, StepStatus } from "../types/run.js";
import { writeJson } from "../utils/fs.js";
import { logInfo } from "../utils/logger.js";
import { env } from "../config/env.js";

const log = (msg: string): void => { if (env.watcherLogging) logInfo(msg); };

// ─── Full-page screenshot helper ──────────────────────────────────────────────

/**
 * Take a screenshot that captures the FULL content of every scrollable
 * fragment on the page — not just what fits in the visible viewport.
 *
 * Playwright's built-in `fullPage: true` only scrolls `window`, so any inner
 * scroll containers (panels, modals, fixed-height divs) are clipped at their
 * rendered height. This helper temporarily expands those containers before
 * capturing, then restores the original styles.
 *
 * Strategy:
 *   1. Find all elements whose scrollHeight exceeds their clientHeight and
 *      whose computed overflow-y is "scroll" or "auto".
 *   2. Save inline overflow/height/maxHeight on a data attribute.
 *   3. Set overflow: visible, height: scrollHeight, maxHeight: none.
 *   4. Take the fullPage screenshot (the expanded document height is now taller).
 *   5. Restore original inline styles from the saved data attribute.
 */
async function takeFullPageScreenshot(page: Page, filePath: string): Promise<void> {
  // Step 1 & 2 & 3 — expand all scroll containers, save originals
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((el) => {
      if (el.scrollHeight <= el.clientHeight + 2) return false;
      const s = window.getComputedStyle(el);
      return s.overflowY === "scroll" || s.overflowY === "auto" ||
             s.overflowX === "scroll" || s.overflowX === "auto";
    });
    for (const el of els) {
      // Persist original inline styles so we can restore them exactly
      el.dataset["screenshotSavedOy"]  = el.style.overflowY;
      el.dataset["screenshotSavedOx"]  = el.style.overflowX;
      el.dataset["screenshotSavedH"]   = el.style.height;
      el.dataset["screenshotSavedMh"]  = el.style.maxHeight;
      // Expand to full scroll height
      el.style.overflowY  = "visible";
      el.style.overflowX  = "visible";
      el.style.height     = `${el.scrollHeight}px`;
      el.style.maxHeight  = "none";
    }
  }).catch(() => {});

  // Step 4 — capture with expanded layout
  try {
    await page.screenshot({ path: filePath, fullPage: true });
  } finally {
    // Step 5 — always restore, even if screenshot threw
    await page.evaluate(() => {
      const els = document.querySelectorAll<HTMLElement>("[data-screenshot-saved-oy],[data-screenshot-saved-h]");
      for (const el of els) {
        el.style.overflowY  = el.dataset["screenshotSavedOy"]  ?? "";
        el.style.overflowX  = el.dataset["screenshotSavedOx"]  ?? "";
        el.style.height     = el.dataset["screenshotSavedH"]   ?? "";
        el.style.maxHeight  = el.dataset["screenshotSavedMh"]  ?? "";
        delete el.dataset["screenshotSavedOy"];
        delete el.dataset["screenshotSavedOx"];
        delete el.dataset["screenshotSavedH"];
        delete el.dataset["screenshotSavedMh"];
      }
    }).catch(() => {});
  }
}

// ─── Public types ──────────────────────────────────────────────────────────────

/**
 * Emitted once per step after the page has fully settled —
 * compares the final page state against the state captured at `setStep()`.
 */
export interface PageContextChange {
  /** Zero-based index of the step that was executing. */
  stepIndex: number;
  /** The step that was active when the change was detected. */
  step: ManualTestStep;
  /**
   * Context snapshot taken at the moment `setStep()` was called
   * (i.e. the page state before the step's actions ran).
   */
  initialContext: PageContext;
  /**
   * Context snapshot taken after the page stopped loading
   * (i.e. the page state once all navigations finished).
   */
  finalContext: PageContext;
  /** Which top-level fields differ between initial and final snapshots. */
  changedFields: Array<"url" | "title" | "elements">;
  /** ISO-8601 timestamp of when the settled snapshot was taken. */
  at: string;
  /** Artifact files saved for this change. */
  artifacts: { contextPath: string; domPath: string };
}

/** Callback invoked once per step after the page has settled. */
export type ContextChangeHandler = (change: PageContextChange) => void | Promise<void>;

// ─── Watcher ──────────────────────────────────────────────────────────────────

/**
 * Listens for page load/navigation events during step execution and emits
 * **one** {@link PageContextChange} per step — fired after the page has been
 * quiet for `WATCHER_SETTLE_MS` (default 800 ms).
 *
 * The change compares the **final settled state** against the **initial state
 * captured at `setStep()`**, so intermediate partial loads are ignored.
 *
 * Usage:
 * ```ts
 * const watcher = new PageContextWatcher(page, artifactDir);
 * watcher.onContextChange(async (change) => { ... });
 * await watcher.attach();
 *
 * // Inside the step loop:
 * watcher.setStep(i, step);          // snapshots initial context
 * // … execute actions …
 * const result = await watcher.captureStep("PASSED", comment, startedAt);
 *
 * watcher.detach();
 * ```
 */
export class PageContextWatcher {
  private readonly page: Page;
  private readonly artifactDir: string;

  private lastContext: PageContext | null = null;
  /** Context captured the moment setStep() is called — used as the diff baseline. */
  private stepStartContext: PageContext | null = null;
  private currentStep: { index: number; step: ManualTestStep } | null = null;

  private readonly handlers: ContextChangeHandler[] = [];
  private attached = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Bound references kept so the exact same listener can be removed later.
  private readonly onFrameNavigated: (frame: Frame) => void;
  private readonly onLoad: () => void;

  constructor(page: Page, artifactDir: string) {
    this.page = page;
    this.artifactDir = artifactDir;

    this.onFrameNavigated = (frame: Frame) => {
      if (frame !== this.page.mainFrame()) return;
      this.scheduleSettle();
    };

    this.onLoad = () => {
      this.scheduleSettle();
    };
  }

  // ── Registration ─────────────────────────────────────────────────────────────

  /** Register a callback fired once per step after the page has settled. */
  onContextChange(handler: ContextChangeHandler): void {
    this.handlers.push(handler);
  }

  // ── Step tracking ─────────────────────────────────────────────────────────────

  /**
   * Call this at the start of each step loop iteration — before any actions run.
   * Snapshots the current page context as the **initial baseline** for diffing.
   * Also cancels any pending settle timer left over from the previous step.
   */
  setStep(index: number, step: ManualTestStep): void {
    this.clearDebounce();
    this.currentStep = { index, step };
    // Snapshot the page state right now so we can diff against it once the
    // page has settled after this step's actions complete.
    this.stepStartContext = this.lastContext;
    log(`[PageContextWatcher] Watching step ${index + 1}: "${step.action}"`);
  }

  // ── Artifact generation ───────────────────────────────────────────────────────

  /**
   * Take a final snapshot of the current page, write the canonical step
   * artifacts (`step-N.png`, `step-N.json`, `step-N.html`), and return a
   * fully-populated `StepResult`.
   */
  async captureStep(
    status: StepStatus,
    comment: string,
    startedAt: string
  ): Promise<StepResult> {
    if (!this.currentStep) throw new Error("captureStep called before setStep");

    const { index, step } = this.currentStep;
    const context = await extractPageContext(this.page);
    const base = path.join(this.artifactDir, `step-${index + 1}`);

    const contextPath = `${base}.json`;
    const domPath = `${base}.html`;
    const screenshotPath = `${base}.png`;

    writeJson(contextPath, context);
    await fs.writeFile(domPath, context.dom, "utf-8");
    await takeFullPageScreenshot(this.page, screenshotPath);

    this.lastContext = context;

    return {
      id: step.id,
      action: step.action,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      comment,
      screenshotPath,
      domPath,
      contextPath
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /** Attach Playwright event listeners and take an initial context snapshot. */
  async attach(): Promise<void> {
    if (this.attached) return;
    this.attached = true;

    try {
      this.lastContext = await extractPageContext(this.page);
    } catch {
      // Page may not be navigated yet — first real event will set the baseline.
    }

    this.page.on("framenavigated", this.onFrameNavigated);
    this.page.on("load", this.onLoad);

    log("[PageContextWatcher] Attached. Will emit once per step after page settles.");
  }

  /** Remove all listeners. Call in the `finally` block after the step loop. */
  detach(): void {
    if (!this.attached) return;
    this.clearDebounce();
    this.page.off("framenavigated", this.onFrameNavigated);
    this.page.off("load", this.onLoad);
    this.attached = false;
    log("[PageContextWatcher] Detached.");
  }

  /** Returns the most recently captured {@link PageContext}. */
  getLastContext(): PageContext | null {
    return this.lastContext;
  }

  /**
   * Wait for the page to be fully idle before proceeding to the next step.
   *
   * Checks in order:
   *   1. networkidle — no in-flight requests for 500 ms
   *   2. No visible loading spinners / progress bars / aria-busy elements
   *
   * Returns the stable {@link PageContext} once the page is ready.
   * Never throws — falls back to whatever state the page is in if timeouts hit.
   */
  async waitForSettle(timeoutMs = 20000): Promise<PageContext> {
    // 1. Wait for network to go idle
    await this.page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});

    // 2. Wait for common loading indicators to disappear
    const spinnerSelectors = [
      '[role="progressbar"]',
      '[aria-busy="true"]',
      '[class*="loading"]:visible',
      '[class*="spinner"]:visible',
      '[class*="loader"]:visible',
      '.loading:visible',
      '.spinner:visible',
    ];

    for (const sel of spinnerSelectors) {
      await this.page
        .waitForSelector(sel, { state: "hidden", timeout: 5000 })
        .catch(() => {}); // selector may not exist — that's fine
    }

    // 3. Snapshot final state
    const ctx = await extractPageContext(this.page);
    this.lastContext = ctx;
    log(`[PageContextWatcher] Page settled for auto-step. URL: ${ctx.url}`);
    return ctx;
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  /**
   * Resets the debounce timer on every navigation/load event.
   * The final emit only happens once the page has been quiet for SETTLE_MS.
   */
  private scheduleSettle(): void {
    if (!this.currentStep) return;
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      void this.emitFinalChange();
    }, env.watcherSettleMs);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Fires once after the page has been quiet for SETTLE_MS.
   * Diffs the current page state against the state captured at setStep()
   * and emits a single PageContextChange if anything changed.
   */
  private async emitFinalChange(): Promise<void> {
    if (!this.currentStep) return;

    const initial = this.stepStartContext;

    let finalContext: PageContext;
    try {
      finalContext = await extractPageContext(this.page);
    } catch {
      return;
    }

    this.lastContext = finalContext;

    // If there was no initial snapshot (first step before any navigation), skip.
    if (!initial) return;

    // ── Diff initial → final ─────────────────────────────────────────────────────
    const changedFields: PageContextChange["changedFields"] = [];

    if (finalContext.url !== initial.url) changedFields.push("url");
    if (finalContext.title !== initial.title) changedFields.push("title");

    const fingerprint = (ctx: PageContext): string =>
      ctx.elements.map((e) => `${e.selector}:${e.visible ? "v" : "h"}`).join("|");

    if (fingerprint(finalContext) !== fingerprint(initial)) changedFields.push("elements");

    if (changedFields.length === 0) return;

    // ── Save artifacts ───────────────────────────────────────────────────────────
    const { index, step } = this.currentStep;
    const base = path.join(this.artifactDir, `step-${index + 1}-settled`);
    const contextPath = `${base}.json`;
    const domPath = `${base}.html`;

    try {
      writeJson(contextPath, finalContext);
      await fs.writeFile(domPath, finalContext.dom, "utf-8");
    } catch {
      // Artifact save failure must never interrupt execution.
    }

    // ── Detailed logging ─────────────────────────────────────────────────────────
    log(`[PageContextWatcher] ── Step ${index + 1} final context (page settled) ────────────────`);

    if (changedFields.includes("url")) {
      log(`[PageContextWatcher]   URL     : ${initial.url}`);
      log(`[PageContextWatcher]           → ${finalContext.url}`);
    }

    if (changedFields.includes("title")) {
      log(`[PageContextWatcher]   Title   : "${initial.title}"`);
      log(`[PageContextWatcher]           → "${finalContext.title}"`);
    }

    if (changedFields.includes("elements")) {
      const prevSelectors = new Map(initial.elements.map((e) => [e.selector, e]));
      const newSelectors  = new Map(finalContext.elements.map((e) => [e.selector, e]));

      const added   = finalContext.elements.filter((e) => !prevSelectors.has(e.selector));
      const removed = initial.elements.filter((e) => !newSelectors.has(e.selector));
      const toggled = finalContext.elements.filter((e) => {
        const old = prevSelectors.get(e.selector);
        return old !== undefined && old.visible !== e.visible;
      });

      log(
        `[PageContextWatcher]   Elements: +${added.length} added, ` +
        `-${removed.length} removed, ${toggled.length} visibility toggled`
      );
      for (const el of added) {
        log(`[PageContextWatcher]     + [${el.tag}] ${el.selector}${el.text ? ` "${el.text.slice(0, 60)}"` : ""}`);
      }
      for (const el of removed) {
        log(`[PageContextWatcher]     - [${el.tag}] ${el.selector}${el.text ? ` "${el.text.slice(0, 60)}"` : ""}`);
      }
      for (const el of toggled) {
        const was = prevSelectors.get(el.selector)!.visible ? "visible" : "hidden";
        const now = el.visible ? "visible" : "hidden";
        log(`[PageContextWatcher]     ~ [${el.tag}] ${el.selector}  ${was} → ${now}`);
      }
    }

    // ── Notify handlers ──────────────────────────────────────────────────────────
    if (this.handlers.length === 0) return;

    const change: PageContextChange = {
      stepIndex: index,
      step,
      initialContext: initial,
      finalContext,
      changedFields,
      at: new Date().toISOString(),
      artifacts: { contextPath, domPath }
    };

    for (const handler of this.handlers) {
      try {
        await handler(change);
      } catch (err) {
        log(`[PageContextWatcher] Handler error: ${(err as Error).message}`);
      }
    }
  }
}
