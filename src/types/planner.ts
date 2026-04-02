export type PlannedActionType = "goto" | "click" | "fill" | "press" | "wait" | "done" | "assert";

export interface PlannedAction {
  action: PlannedActionType;
  target?: string;
  value?: string;
  valueKey?: string;
  explanation?: string;
  notes?: string;
  stopExecution?: boolean;
}

export interface StepPlan {
  manualStepId: string;
  manualStepAction: string;
  actions: PlannedAction[];
}
