export type PlannedActionType = "goto" | "click" | "fill" | "press" | "wait" | "done" | "assert";

/**
 * Describes the UI element type the action targets.
 * Used by the executor to apply the correct interaction strategy
 * (e.g. wait for suggestions on autocomplete, wait for panel on accordion).
 */
export type ElementType =
  | "button"
  | "link"
  | "menuitem"          // nav items, dropdown options, list items
  | "input-text"
  | "input-autocomplete" // fill → wait for suggestions → select matching option
  | "input-password"
  | "select"            // native <select>
  | "dropdown"          // custom div-based dropdown
  | "checkbox"
  | "radio"
  | "tab"               // tab control — panel renders after click
  | "accordion"         // expand/collapse — child elements appear after click
  | "table-row"
  | "label"
  | "other";

export interface PlannedAction {
  action: PlannedActionType;
  target?: string;
  value?: string;
  valueKey?: string;
  /** UI element type — drives executor strategy and dynamic element discovery. */
  elementType?: ElementType;
  explanation?: string;
  notes?: string;
  stopExecution?: boolean;
}

export interface StepPlan {
  manualStepId: string;
  manualStepAction: string;
  actions: PlannedAction[];
}
