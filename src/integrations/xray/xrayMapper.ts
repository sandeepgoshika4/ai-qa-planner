import type { ManualTestCase, ManualTestStep } from "../../types/manualTest.js";
import type { XrayTestNode, XrayTestsQueryData } from "../../types/xray.js";

function mapStep(step: { id?: string; action?: string; data?: string; result?: string }, index: number): ManualTestStep {
  return {
    id: step.id ?? `step-${index + 1}`,
    action: step.action ?? `Unnamed step ${index + 1}`,
    data: step.data ?? "",
    expectedResult: step.result ?? ""
  };
}

export function mapXrayTestNodeToManualTestCase(node: XrayTestNode): ManualTestCase {
  return {
    testCaseKey: node.jira?.key,
    testName: node.jira?.summary ?? node.jira?.key ?? "Unnamed Xray Test",
    description: node.jira?.description ?? "",
    startUrl: undefined,
    dataSet: {},
    steps: (node.steps ?? []).map(mapStep),
    source: "xray",
    rawSource: node
  };
}

export function mapXrayTestsToManualCases(data: XrayTestsQueryData): ManualTestCase[] {
  return (data.getTests?.results ?? []).map(mapXrayTestNodeToManualTestCase);
}
