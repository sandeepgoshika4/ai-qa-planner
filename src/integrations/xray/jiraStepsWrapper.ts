import path from "node:path";
import { JiraClient } from "./jiraClient.js";
import { logInfo } from "../../utils/logger.js";
import { JiraIssueFields } from "../../types/jiraFields.js";
import { ManualTestCase, ManualTestStep } from "../../types/manualTest.js";
import { readJson } from "../../utils/fs.js";

export async function fetchJiraStepsWithExtras(jiraIssue: string): Promise<ManualTestCase> {
  const jiraClient = new JiraClient();
  const jql = `key=${jiraIssue}`;
  const jiraResults: JiraIssueFields = await jiraClient.searchIssuesByJql(jql);

  const labels = jiraResults?.labels || [];
  const lob = labels.includes("clearing")
    ? "clearing"
    : labels.includes("custody")
    ? "custody"
    : "";
  const envName = (jiraResults as any).environment || "";
  const preStepfileName = `${envName}-${lob}-pre-steps.json`;
  const preStepPath = path.join(process.cwd(), "src", "preSteps", preStepfileName);

  let preSteps: Partial<ManualTestCase> = {};
  try {
    preSteps = readJson<ManualTestCase>(preStepPath) || {};
  } catch (e) {
    logInfo(`Pre-steps file not found at ${preStepPath}, continuing without pre-steps`);
    preSteps = {};
  }

  const totalSteps: ManualTestStep[] = [
    ...(preSteps.steps || []),
    ...(jiraResults.steps || [])
  ];

  const manualCase: ManualTestCase = {
    testCaseKey: jiraResults?.testCaseKey,
    testName: jiraResults?.testName,
    description: jiraResults?.description,
    startUrl: preSteps.startUrl,
    dataSet: preSteps.dataSet || {},
    steps: totalSteps,
    source: "jira"
  };

  // Log results
  logInfo(`Steps for Jira issue ${jiraIssue}:`);
  logInfo(JSON.stringify(manualCase.steps || [], null, 2));

  return manualCase;
}
