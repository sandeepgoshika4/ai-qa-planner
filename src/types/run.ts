import type { ManualTestCase } from "./manualTest.js";

export type StepStatus = "PASSED" | "FAILED" | "MANUAL_PASSED" | "SKIPPED" | "BLOCKED" | "MANUAL_REQUIRED";

export interface StepResult {
  id: string;
  action: string;
  status: StepStatus;
  startedAt: string;
  finishedAt: string;
  comment?: string;
  screenshotPath?: string;
  domPath?: string;
}

export interface RunState {
  runId: string;
  testCase: ManualTestCase;
  currentStepIndex: number;
  stepResults: StepResult[];
  startedAt: string;
  paused: boolean;
}

export interface PendingUploadRecord {
  pendingId: string;
  runId: string;
  createdAt: string;
  source: "xray";
  approved: boolean;
  rejected: boolean;
  uploadPayload: unknown;
  artifactsFolder: string;
  note?: string;
}
