import { loadManualTestFile } from "./config/manualTestLoader.js";
import { parseCliArgs } from "./config/cliArgs.js";
import { XrayClient } from "./integrations/xray/xrayClient.js";
import { mapXrayTestsToManualCases } from "./integrations/xray/xrayMapper.js";
import { runManualTest } from "./runner.js";
import { loadRunState } from "./storage/runStateStore.js";
import { logError, logInfo } from "./utils/logger.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.resume) {
    const state = loadRunState(args.resume);
    await runManualTest(state.testCase, state, { auto: args.auto });
    return;
  }

  let cases = [];
  if (args.file) {
    cases = [loadManualTestFile(args.file)];
  } else if (args.xrayIssue || args.xrayJql) {
    const client = new XrayClient();
    const raw = args.xrayIssue ? await client.fetchTestsByIssueKey(args.xrayIssue) : await client.fetchTestsByJql(args.xrayJql!);
    cases = mapXrayTestsToManualCases(raw);
  } else {
    throw new Error("Pass --file, --xray-issue, --xray-jql, or --resume");
  }

  for (const testCase of cases) {
    logInfo(`Running: ${testCase.testName}`);
    const result = await runManualTest(testCase, undefined, { auto: args.auto });
    if (result.pendingUploadPath) {
      logInfo(`Review artifacts, then approve upload: npm run approve:upload -- ${result.pendingUploadPath} --approve`);
    }
  }
}
main().catch((e) => { logError((e as Error).stack ?? String(e)); process.exit(1); });
