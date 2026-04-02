import type { Page } from "playwright";
import { env } from "../config/env.js";
import type { PlannedAction } from "../types/planner.js";
import { logInfo } from "../utils/logger.js";
import { resolveLocator } from "./locatorResolver.js";
import { HumanVerificationRequiredError } from "../errors/humanVerificationError.js";
import { detectHumanVerification } from "../detectors/detectHumanVerification.js";

async function ensureNoHumanVerification(page: Page): Promise<void> {
  const reason = await detectHumanVerification(page);
  if (reason) throw new HumanVerificationRequiredError(reason);
}

export async function executePlannedActions(
  page: Page,
  actions: PlannedAction[],
  dataSet: Record<string, string>
): Promise<void> {
  for (const action of actions) {
    if (action.notes) {
      logInfo(`Planner notes: ${action.notes}`);
    }

    if (action.stopExecution) {
      logInfo("Execution stopped by planner due to blocked/unexpected state.");
      return;
    }

    logInfo(`Executing action: ${action.action}${action.target ? ` -> ${action.target}` : ""}`);

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
        break;
      }

      case "fill": {
        if (!action.target) throw new Error("fill missing target");
        const value = action.valueKey ? dataSet[action.valueKey] : action.value;
        if (value == null) throw new Error("fill missing value");
        const loc = resolveLocator(page, action.target).first();
        await loc.highlight();
        await loc.fill(value);
        await ensureNoHumanVerification(page);
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
        return;
    }

    await page.waitForTimeout(env.stepDelayMs);
  }
}
