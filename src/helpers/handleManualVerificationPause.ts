import { Page } from "playwright";
import { RunState } from "../types/run.js";
import { saveRunState } from "../storage/runStateStore.js";
import { persistArtifacts } from "../runner.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { prompt } from "../utils/cli.js";
import { extractPageContext } from "../browser/extractor.js";
import { waitForManualVerificationToComplete } from "./waitForManualVerificationToComplete.js";

export async function handleManualVerificationPause(
    page: Page,
    state: RunState,
    artifactDir: string,
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

    const beforeContext = await extractPageContext(page);
    state.stepResults.push(
        await persistArtifacts(
            page,
            artifactDir,
            stepIndex,
            step.id,
            step.action,
            "MANUAL_REQUIRED",
            beforeContext,
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