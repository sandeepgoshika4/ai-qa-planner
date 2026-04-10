import path from "node:path";
import { chromium } from "playwright";
import { OpenAiPlanner } from "./agents/openAiPlanner.js";
import { env } from "./config/env.js";
import { extractPageContext } from "./browser/extractor.js";
import { executePlannedActions } from "./browser/executor.js";
import { PageContextWatcher } from "./browser/pageContextWatcher.js";
import type { ManualTestCase } from "./types/manualTest.js";
import type { PendingUploadRecord, RunState } from "./types/run.js";
import { loadCachedStepPlan, saveCachedStepPlan } from "./storage/planStore.js";
import { savePendingUpload } from "./storage/pendingUploadStore.js";
import { saveRunState } from "./storage/runStateStore.js";
import { ensureDir, slugify } from "./utils/fs.js";
import { prompt } from "./utils/cli.js";
import { logInfo, logWarn, logError } from "./utils/logger.js";
import { FatalExecutionError } from "./errors/fatalExecutionError.js";
import { buildXrayExecutionImportPayload } from "./integrations/xray/uploadMapper.js";
import { detectBlockedState } from "./detectors/detectBlockedState.js";
import { detectHumanVerification } from "./detectors/detectHumanVerification.js";
import { handleManualVerificationPause } from "./helpers/handleManualVerificationPause.js";

export async function runManualTest(
  testCase: ManualTestCase,
  resumeState?: RunState,
  options?: { auto?: boolean }
): Promise<{ runState: RunState; pendingUploadPath?: string }> {
  const autoMode = options?.auto ?? false;
  const planner = new OpenAiPlanner();
  const runId = resumeState?.runId ?? `${Date.now()}-${slugify(testCase.testName)}`;
  const artifactDir = ensureDir(path.resolve("out/runs", runId));

  const state: RunState = resumeState ?? {
    runId,
    testCase,
    currentStepIndex: 0,
    stepResults: [],
    startedAt: new Date().toISOString(),
    paused: false
  };

  const browser = await chromium.launch({ headless: env.headless, slowMo: env.slowMo });
  const context = await browser.newContext();
  const page = await context.newPage();

  // The watcher owns all artifact generation (screenshots, DOM, context JSON)
  // and fires callbacks on every page-context change during step execution.
  const watcher = new PageContextWatcher(page, artifactDir);
  watcher.onContextChange(async (change) => {
    if (env.watcherLogging) {
      logInfo(
        `[Watcher] Step ${change.stepIndex + 1} — page settled ` +
        `(${change.changedFields.join(", ")}): ${change.initialContext.url} → ${change.finalContext.url}`
      );
    }
  });
  await watcher.attach();

  if (testCase.startUrl) {
    await page.goto(testCase.startUrl, { waitUntil: "networkidle" });
  }

  try {
    for (let i = state.currentStepIndex; i < testCase.steps.length; i++) {
      state.currentStepIndex = i;
      saveRunState(state);

      const step = testCase.steps[i];
      logInfo(`\nStep ${i + 1}/${testCase.steps.length}: ${step.action}`);

      // Register the active step with the watcher before anything else runs.
      watcher.setStep(i, step);

      let current: Awaited<ReturnType<typeof extractPageContext>>;

      if (autoMode) {
        // In auto mode: wait for the page to fully settle before each step,
        // then proceed without any user prompt.
        logInfo("Auto mode: waiting for page to settle...");
        current = await watcher.waitForSettle();
      } else {
        const cmd = (await prompt("Enter = continue, m = manual mode, s = save & stop: ")).toLowerCase();

        if (cmd === "s") {
          state.paused = true;
          const statePath = saveRunState(state);
          logWarn(`Stopped. Resume later with: npm run dev -- --resume ${statePath}`);
          break;
        }

        if (cmd === "m") {
          const startedAt = new Date().toISOString();
          logInfo("Manual mode enabled. Perform the step yourself in the open browser.");
          await prompt("Press Enter when the manual step is finished: ");
          state.stepResults.push(
            await watcher.captureStep("MANUAL_PASSED", "Marked as manual pass by operator.", startedAt)
          );
          saveRunState(state);
          continue;
        }

        current = await extractPageContext(page);
      }

      const startedAt = new Date().toISOString();

      const humanVerificationReason = await detectHumanVerification(page);
      if (humanVerificationReason) {
        await handleManualVerificationPause(page, state, watcher, i, step, startedAt, humanVerificationReason);
        current = await extractPageContext(page);
      }

      const blockedReasonBeforePlan = await detectBlockedState(page);
      if (blockedReasonBeforePlan) {
        logWarn(`Blocked page detected before planning: ${blockedReasonBeforePlan}`);
        state.stepResults.push(
          await watcher.captureStep("BLOCKED", `Execution stopped. Blocked page detected: ${blockedReasonBeforePlan}`, startedAt)
        );
        state.paused = true;
        saveRunState(state);
        break;
      }

      const urlForDomain = current.url || testCase.startUrl || "https://local.invalid";
      const domain = new URL(urlForDomain).hostname;
      let plan = loadCachedStepPlan(domain, step.action);

      if (!plan) {
        logInfo("Calling LLM planner");
        plan = await planner.planStep(step, current, testCase.dataSet);
        saveCachedStepPlan(domain, step.action, plan);
      } else {
        logInfo("Using cached step plan");
      }

      try {
        const resolvedActions = await executePlannedActions(page, plan.actions, testCase.dataSet, step.action);
        // Write resolved locators back to cache so the next run skips dynamic discovery
        saveCachedStepPlan(domain, step.action, { ...plan, actions: resolvedActions });

        state.stepResults.push(
          await watcher.captureStep("PASSED", step.expectedResult ?? "Completed", startedAt)
        );
      } catch (error) {
        // ── Fatal system/service error: do NOT re-plan, do NOT heal ─────────────
        if (error instanceof FatalExecutionError) {
          logError(`\n[FATAL] ${error.message}`);
          if (error.cause) logError(`  Caused by: ${error.cause.message}`);
          state.stepResults.push(
            await watcher.captureStep(
              "FAILED",
              `Fatal error — system/service unavailable: ${error.message}`,
              startedAt
            )
          );
          saveRunState(state);
          // Stop executing the remaining steps — the service is down
          break;
        }

        // ── Recoverable failure: re-plan with fresh context ───────────────────
        logWarn(`Plan failed: ${(error as Error).message}`);
        let refreshed = await extractPageContext(page);

        const retryHumanVerificationReason = await detectHumanVerification(page);
        if (retryHumanVerificationReason) {
          await handleManualVerificationPause(page, state, watcher, i, step, startedAt, retryHumanVerificationReason);
          refreshed = await extractPageContext(page);
        }

        try {
          // Re-plan with fresh context (Idea 4 fallback)
          plan = await planner.planStep(step, refreshed, testCase.dataSet);
          const resolvedActions = await executePlannedActions(page, plan.actions, testCase.dataSet, step.action);
          // Cache the re-planned + resolved actions so this fallback only happens once
          saveCachedStepPlan(domain, step.action, { ...plan, actions: resolvedActions });

          state.stepResults.push(
            await watcher.captureStep("PASSED", step.expectedResult ?? "Completed", startedAt)
          );
        } catch (retryError) {
          // Re-plan also failed — check if it's fatal before giving up
          if (retryError instanceof FatalExecutionError) {
            logError(`\n[FATAL] ${(retryError as FatalExecutionError).message}`);
          } else {
            logError(`Step ${i + 1} failed after re-plan: ${(retryError as Error).message}`);
          }
          state.stepResults.push(
            await watcher.captureStep(
              "FAILED",
              `Step failed: ${(retryError as Error).message}`,
              startedAt
            )
          );
          saveRunState(state);
          break;
        }
      }

      saveRunState(state);
      saveRunState(state);
    }
  } finally {
    watcher.detach();
    if (!env.keepBrowserOpen) await browser.close();
  }

  let pendingUploadPath: string | undefined;
  if (testCase.source === "xray" && testCase.testCaseKey && state.stepResults.length > 0) {
    const record: PendingUploadRecord = {
      pendingId: `${state.runId}-pending-upload`,
      runId: state.runId,
      createdAt: new Date().toISOString(),
      source: "xray",
      approved: false,
      rejected: false,
      uploadPayload: buildXrayExecutionImportPayload(testCase, state.stepResults),
      artifactsFolder: artifactDir
    };
    pendingUploadPath = savePendingUpload(record);
    logInfo(`Pending upload saved: ${pendingUploadPath}`);
  }

  saveRunState(state);
  return { runState: state, pendingUploadPath };
}
