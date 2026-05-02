import { loadManualTestFile } from "./config/manualTestLoader.js";
import { parseCliArgs } from "./config/cliArgs.js";
import { fetchJiraStepsWithExtras } from "./integrations/xray/jiraStepsWrapper.js";
import { runManualTest } from "./runner.js";
import { loadRunState } from "./storage/runStateStore.js";
import { logError, logInfo } from "./utils/logger.js";
import type { ManualTestCase } from "./types/manualTest.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.resume) {
    const state = loadRunState(args.resume);
    await runManualTest(state.testCase, state, { auto: args.auto, approve: args.approve });
    return;
  }

  let cases: ManualTestCase[] = [];
  if (args.file) {
    cases = [loadManualTestFile(args.file)];
  } else if (args.jiraIssue) {
    // Use wrapper to fetch and append steps based on labels
    cases = [await fetchJiraStepsWithExtras(args.jiraIssue)];
  } else {
    throw new Error("Pass --file, --jira-issue, or --resume");
  }

  for (const testCase of cases) {
    logInfo(`Running: ${testCase.testName}`);
    const result = await runManualTest(testCase, undefined, { auto: args.auto, approve: args.approve });
    if (result.pendingUploadPath) {
      logInfo(`Review artifacts, then approve upload: npm run approve:upload -- ${result.pendingUploadPath} --approve`);
    }
  }
}
main().catch((e) => { logError((e as Error).stack ?? String(e)); process.exit(1); });
