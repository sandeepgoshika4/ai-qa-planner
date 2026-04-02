export interface ManualTestStep {
  id: string;
  action: string;
  data?: string;
  expectedResult?: string;
}

export interface ManualTestCase {
  testCaseKey?: string;
  testName: string;
  description?: string;
  startUrl?: string;
  dataSet: Record<string, string>;
  steps: ManualTestStep[];
  source: "json" | "xray";
  rawSource?: unknown;
}
