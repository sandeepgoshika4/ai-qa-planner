import { ManualTestStep } from "./manualTest.js";

export interface JiraIssueFields {
  testCaseKey?: string;
  testName: string;
  description?: string;
  steps: ManualTestStep[];
  source: "jira";
  labels: string[];
  environment?: string;
}
