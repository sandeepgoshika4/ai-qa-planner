import { Page } from "playwright";
import { RunState } from "../types/run.js";
import { saveRunState } from "../storage/runStateStore.js";
import { PageContextWatcher } from "../browser/pageContextWatcher.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { prompt } from "../utils/cli.js";
import { waitForManualVerificationToComplete } from "./waitForManualVerificationToComplete.js";

export async function handleManualVerificationPause(
    page: Page,
    state: RunState,
    watcher: PageContextWatcher,
    stepIndex: number,
    step: { id: string; action: string },
    startedAt: string,
    reason: string
): Promise<void> {
    logWarn(`Manual verification required: ${reason}`);
    logInfo("Please complete the CAPTCHA / human verification in the open browser.");
    logInfo("The test will auto-resume once verification is completed.");
    logInfo("If auto-resume does not happen, press Enter as fallback.");

    state.paused = true;
    saveRunState(state);

    state.stepResults.push(
        await watcher.captureStep(
            "MANUAL_REQUIRED",
            `Manual verification required: ${reason}`,
            startedAt
        )
    );
    saveRunState(state);

    const originalUrl = page.url();

    const result = await Promise.race([
        waitForManualVerificationToComplete(page, originalUrl, 180000),
        (async () => {
            await prompt("Press Enter only if verification is already complete and auto-resume did not happen: ");
            return "resolved" as const;
        })()
    ]);

    if (result === "timeout") {
        throw new Error("Timed out waiting for manual verification to complete.");
    }

    state.paused = false;
    saveRunState(state);

    logInfo("\nResuming test after manual verification.");
}
