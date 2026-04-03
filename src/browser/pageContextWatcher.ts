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

// ─── Public types ──────────────────────────────────────────────────────────────

/**
 * Describes what changed between two page-context snapshots during a step.
 */
export interface PageContextChange {
  /** Zero-based index of the step currently executing. */
  stepIndex: number;
  /** The step that was active when the change was detected. */
  step: ManualTestStep;
  /** Context snapshot captured just before this change. */
  previousContext: PageContext;
  /** Freshly extracted context after the change was detected. */
  currentContext: PageContext;
  /** Which top-level fields actually differ between the two snapshots. */
  changedFields: Array<"url" | "title" | "elements">;
  /**
   * What triggered the check:
   * - `"navigation"` – main-frame URL changed (`framenavigated` event)
   * - `"load"`       – page finished loading (`load` event)
   */
  trigger: "navigation" | "load";
  /** ISO-8601 timestamp of when the change was detected. */
  at: string;
  /**
   * Paths of the intermediate artifacts automatically saved for this change.
   * Only present when `artifactDir` was supplied to the constructor.
   */
  artifacts?: { screenshotPath: string; contextPath: string; domPath: string };
}

/** Callback invoked whenever a meaningful page-context change is detected. */
export type ContextChangeHandler = (change: PageContextChange) => void | Promise<void>;

// ─── Watcher ──────────────────────────────────────────────────────────────────

/**
 * Attaches lightweight Playwright event listeners to a `Page` and:
 *
 * 1. **Auto-saves intermediate artifacts** (screenshot + context JSON + DOM HTML)
 *    on every meaningful page-context change during step execution.
 *
 * 2. **Produces the final `StepResult`** via {@link captureStep} — takes a
 *    fresh context snapshot, writes the canonical `step-N.*` artifact files,
 *    and assembles the complete result object so `runner.ts` never has to touch
 *    the file-system directly.
 *
 * Usage:
 * ```ts
 * const watcher = new PageContextWatcher(page, artifactDir);
 * watcher.onContextChange(async (change) => { ... });
 * await watcher.attach();
 *
 * // Inside the step loop:
 * watcher.setStep(i, step);
 * // … execute actions …
 * const result = await watcher.captureStep("PASSED", step.expectedResult, startedAt);
 *
 * // Cleanup:
 * watcher.detach();
 * ```
 */
export class PageContextWatcher {
  private readonly page: Page;
  private readonly artifactDir: string;

  private lastContext: PageContext | null = null;
  private currentStep: { index: number; step: ManualTestStep } | null = null;
  private changeCounter = 0;

  private readonly handlers: ContextChangeHandler[] = [];
  private attached = false;

  // Bound references kept so the exact same listener can be removed later.
  private readonly onFrameNavigated: (frame: Frame) => void;
  private readonly onLoad: () => void;

  constructor(page: Page, artifactDir: string) {
    this.page = page;
    this.artifactDir = artifactDir;

    this.onFrameNavigated = (frame: Frame) => {
      if (frame !== this.page.mainFrame()) return;
      void this.checkAndEmit("navigation");
    };

    this.onLoad = () => {
      void this.checkAndEmit("load");
    };
  }

  // ── Registration ─────────────────────────────────────────────────────────────

  /**
   * Register a callback that fires on every meaningful context change.
   * Multiple handlers are supported and are called in registration order.
   */
  onContextChange(handler: ContextChangeHandler): void {
    this.handlers.push(handler);
  }

  // ── Step tracking ─────────────────────────────────────────────────────────────

  /**
   * Tell the watcher which step is currently executing.
   * Call this at the top of each step-loop iteration **before** any actions run.
   * Resets the intermediate-change counter for clean per-step artifact naming.
   */
  setStep(index: number, step: ManualTestStep): void {
    this.currentStep = { index, step };
    this.changeCounter = 0;
    log(`[PageContextWatcher] Watching step ${index + 1}: "${step.action}"`);
  }

  // ── Artifact generation ───────────────────────────────────────────────────────

  /**
   * Take a final snapshot of the current page, write the canonical step
   * artifacts (`step-N.png`, `step-N.json`, `step-N.html`), and return a
   * fully-populated `StepResult`.
   *
   * This replaces the old `persistArtifacts` helper in `runner.ts`.
   *
   * @param status    - The outcome of the step (PASSED, FAILED, BLOCKED, etc.)
   * @param comment   - A human-readable comment or expected-result note.
   * @param startedAt - ISO-8601 timestamp recorded before execution began.
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
    await this.page.screenshot({ path: screenshotPath, fullPage: true });

    // Keep the internal baseline in sync so subsequent diff checks are accurate.
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

  /**
   * Attach Playwright event listeners and take an initial context snapshot.
   * Safe to call multiple times (no-op after the first call).
   */
  async attach(): Promise<void> {
    if (this.attached) return;
    this.attached = true;

    try {
      this.lastContext = await extractPageContext(this.page);
    } catch {
      // Page may not be navigated yet – first real event will set the baseline.
    }

    this.page.on("framenavigated", this.onFrameNavigated);
    this.page.on("load", this.onLoad);

    log("[PageContextWatcher] Attached and listening for page context changes.");
  }

  /**
   * Remove all listeners added by this watcher.
   * Call this in the `finally` block after the step loop completes.
   */
  detach(): void {
    if (!this.attached) return;
    this.page.off("framenavigated", this.onFrameNavigated);
    this.page.off("load", this.onLoad);
    this.attached = false;
    log("[PageContextWatcher] Detached.");
  }

  /**
   * Returns the most recently captured {@link PageContext}, or `null` if
   * `attach()` has not been called or the page was not yet navigated.
   */
  getLastContext(): PageContext | null {
    return this.lastContext;
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  private async checkAndEmit(trigger: PageContextChange["trigger"]): Promise<void> {
    if (!this.currentStep) return;

    let newContext: PageContext;
    try {
      newContext = await extractPageContext(this.page);
    } catch {
      // Page is mid-navigation and not yet ready – skip this event.
      return;
    }

    const prev = this.lastContext;
    if (!prev) {
      this.lastContext = newContext;
      return;
    }

    // ── Diff ────────────────────────────────────────────────────────────────────
    const changedFields: PageContextChange["changedFields"] = [];

    if (newContext.url !== prev.url) changedFields.push("url");
    if (newContext.title !== prev.title) changedFields.push("title");

    // Lightweight element fingerprint – avoids full DOM string comparison.
    const fingerprint = (ctx: PageContext): string =>
      ctx.elements.map((e) => `${e.selector}:${e.visible ? "v" : "h"}`).join("|");

    if (fingerprint(newContext) !== fingerprint(prev)) changedFields.push("elements");

    if (changedFields.length === 0) {
      this.lastContext = newContext;
      return;
    }

    this.lastContext = newContext;
    this.changeCounter++;

    // ── Intermediate artifact save ───────────────────────────────────────────────
    const { index, step } = this.currentStep;
    const base = path.join(
      this.artifactDir,
      `step-${index + 1}-change-${this.changeCounter}`
    );
    const contextPath = `${base}.json`;
    const domPath = `${base}.html`;
    const screenshotPath = `${base}.png`;

    try {
      writeJson(contextPath, newContext);
      await fs.writeFile(domPath, newContext.dom, "utf-8");
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {
      // Artifact save failure must never interrupt execution.
    }

    // ── Detailed change logging ──────────────────────────────────────────────────
    log(
      `[PageContextWatcher] ── Step ${index + 1} context changed ` +
      `(trigger: ${trigger}) ──────────────────────────────`
    );

    if (changedFields.includes("url")) {
      log(`[PageContextWatcher]   URL     : ${prev.url}`);
      log(`[PageContextWatcher]           → ${newContext.url}`);
    }

    if (changedFields.includes("title")) {
      log(`[PageContextWatcher]   Title   : "${prev.title}"`);
      log(`[PageContextWatcher]           → "${newContext.title}"`);
    }

    if (changedFields.includes("elements")) {
      const prevSelectors = new Map(prev.elements.map((e) => [e.selector, e]));
      const newSelectors  = new Map(newContext.elements.map((e) => [e.selector, e]));

      const added   = newContext.elements.filter((e) => !prevSelectors.has(e.selector));
      const removed = prev.elements.filter((e) => !newSelectors.has(e.selector));
      const toggled = newContext.elements.filter((e) => {
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

    log(`[PageContextWatcher]   Artifacts saved: ${path.basename(screenshotPath)}`);

    // ── Notify handlers ──────────────────────────────────────────────────────────
    if (this.handlers.length === 0) return;

    const change: PageContextChange = {
      stepIndex: index,
      step,
      previousContext: prev,
      currentContext: newContext,
      changedFields,
      trigger,
      at: new Date().toISOString(),
      artifacts: { screenshotPath, contextPath, domPath }
    };

    for (const handler of this.handlers) {
      try {
        await handler(change);
      } catch (err) {
        // Handler errors must never crash the executor.
        log(`[PageContextWatcher] Handler error: ${(err as Error).message}`);
      }
    }
  }
}
