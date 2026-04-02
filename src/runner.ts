import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { OpenAiPlanner } from "./agents/openAiPlanner.js";
import { env } from "./config/env.js";
import { extractPageContext } from "./browser/extractor.js";
import { executePlannedActions } from "./browser/executor.js";
import type { ManualTestCase } from "./types/manualTest.js";
import type { PendingUploadRecord, RunState, StepResult } from "./types/run.js";
import { loadCachedStepPlan, saveCachedStepPlan } from "./storage/planStore.js";
import { savePendingUpload } from "./storage/pendingUploadStore.js";
import { saveRunState } from "./storage/runStateStore.js";
import { ensureDir, slugify, writeJson } from "./utils/fs.js";
import { prompt } from "./utils/cli.js";
import { logInfo, logWarn } from "./utils/logger.js";
import { buildXrayExecutionImportPayload } from "./integrations/xray/uploadMapper.js";
import { detectBlockedState } from "./detectors/detectBlockedState.js";
import { detectHumanVerification } from "./detectors/detectHumanVerification.js";
import { handleManualVerificationPause } from "./helpers/handleManualVerificationPause.js";

export async function runManualTest(testCase: ManualTestCase, resumeState?: RunState): Promise<{ runState: RunState; pendingUploadPath?: string }> {
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

  if (testCase.startUrl) {
    await page.goto(testCase.startUrl, { waitUntil: "networkidle" });
  }

  try {
    for (let i = state.currentStepIndex; i < testCase.steps.length; i++) {
      state.currentStepIndex = i;
      saveRunState(state);

      const step = testCase.steps[i];
      logInfo(`\nStep ${i + 1}/${testCase.steps.length}: ${step.action}`);
      const cmd = (await prompt("Enter = continue, m = manual mode, s = save & stop: ")).toLowerCase();

      if (cmd === "s") {
        state.paused = true;
        const statePath = saveRunState(state);
        logWarn(`Stopped. Resume later with: npm run dev -- --resume ${statePath}`);
        break;
      }

      const startedAt = new Date().toISOString();

      if (cmd === "m") {
        logInfo("Manual mode enabled. Perform the step yourself in the open browser.");
        await prompt("Press Enter when the manual step is finished: ");
        const current = await extractPageContext(page);
        state.stepResults.push(await persistArtifacts(page, artifactDir, i, step.id, step.action, "MANUAL_PASSED", current, "Marked as manual pass by operator.", startedAt));
        saveRunState(state);
        continue;
      }

      let current = await extractPageContext(page);

      const humanVerificationReason = await detectHumanVerification(page);
      if (humanVerificationReason) {
        await handleManualVerificationPause(
          page,
          state,
          artifactDir,
          i,
          step,
          startedAt,
          humanVerificationReason
        );
        current = await extractPageContext(page);
      }

      const blockedReasonBeforePlan = await detectBlockedState(page);
      if (blockedReasonBeforePlan) {
        logWarn(`Blocked page detected before planning: ${blockedReasonBeforePlan}`);

        state.stepResults.push(
          await persistArtifacts(
            page,
            artifactDir,
            i,
            step.id,
            step.action,
            "BLOCKED",
            current,
            `Execution stopped. Blocked page detected: ${blockedReasonBeforePlan}`,
            startedAt
          )
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
        await executePlannedActions(page, plan.actions, testCase.dataSet);
      } catch (error) {
        logWarn(`Plan failed: ${(error as Error).message}`);
        let refreshed = await extractPageContext(page);

        const retryHumanVerificationReason = await detectHumanVerification(page);
        if (retryHumanVerificationReason) {
          await handleManualVerificationPause(
            page,
            state,
            artifactDir,
            i,
            step,
            startedAt,
            retryHumanVerificationReason
          );
          refreshed = await extractPageContext(page);
        }

        plan = await planner.planStep(step, refreshed, testCase.dataSet);
        saveCachedStepPlan(domain, step.action, plan);
        await executePlannedActions(page, plan.actions, testCase.dataSet);
      }

      const finished = await extractPageContext(page);
      state.stepResults.push(await persistArtifacts(page, artifactDir, i, step.id, step.action, "PASSED", finished, step.expectedResult ?? "Completed", startedAt));
      saveRunState(state);
    }
  } finally {
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

export async function persistArtifacts(
  page: Page,
  artifactDir: string,
  index: number,
  stepId: string,
  action: string,
  status: StepResult["status"],
  context: Awaited<ReturnType<typeof extractPageContext>>,
  comment: string,
  startedAt: string
): Promise<StepResult> {
  const base = path.join(artifactDir, `step-${index + 1}`);
  const domPath = `${base}.html`;
  const contextPath = `${base}.json`;
  const screenshotPath = `${base}.png`;
  writeJson(contextPath, context);
  await fs.writeFile(domPath, context.dom, "utf-8");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return {
    id: stepId,
    action,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    comment,
    screenshotPath,
    domPath,
    contextPath
  };
}

