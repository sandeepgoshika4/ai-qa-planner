import type { ManualTestCase } from "../../types/manualTest.js";
import type { StepResult } from "../../types/run.js";

export function buildXrayExecutionImportPayload(testCase: ManualTestCase, stepResults: StepResult[]): unknown {
  const overallStatus = stepResults.every((s) => s.status === "PASSED" || s.status === "MANUAL_PASSED") ? "PASSED" : "FAILED";
  return {
    tests: [
      {
        testKey: testCase.testCaseKey,
        status: overallStatus,
        comment: "Uploaded from Playwright + LLM agent after manual verification.",
        steps: stepResults.map((s) => ({
          status: s.status === "FAILED" ? "FAILED" : "PASSED",
          comment: s.comment ?? "",
          actualResult: s.comment ?? ""
        }))
      }
    ]
  };
}
