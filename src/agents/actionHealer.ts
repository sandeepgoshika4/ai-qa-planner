import { env } from "../config/env.js";
import { makeLlmClient } from "../llm/client.js";
import { filterPageContext, type PlannerContext } from "../browser/pageContextFilter.js";
import type { PlannedAction } from "../types/planner.js";
import type { PageContext } from "../types/pageContext.js";
import { logInfo, logWarn } from "../utils/logger.js";

export class ActionHealer {
  private client = makeLlmClient();

  /**
   * Attempt to repair a single failed action by asking the LLM to produce a
   * corrected version given the current page state.
   *
   * @param failedAction    - The action that threw or timed out.
   * @param error           - The error message from the failure.
   * @param pageContext     - Fresh page context captured right after the failure.
   * @param stepDescription - The original manual test step text (preserves intent).
   * @param completedActions - Actions that already ran successfully before the failure.
   * @returns A repaired PlannedAction, or null if the LLM cannot suggest a fix.
   */
  async repairAction(
    failedAction: PlannedAction,
    error: string,
    pageContext: PageContext,
    stepDescription: string,
    completedActions: PlannedAction[]
  ): Promise<PlannedAction | null> {
    logInfo(`[ActionHealer] Attempting to repair action: ${failedAction.action}${failedAction.target ? ` -> ${failedAction.target}` : ""}`);

    // Use a smaller cap for healing — focus on the most actionable elements
    const filtered = filterPageContext(pageContext, 40);
    const prompt = this.buildPrompt(failedAction, error, filtered, stepDescription, completedActions);

    try {
      const response = await this.client.chat.completions.create({
        model: env.openAiModel,
        messages: [
          {
            role: "system",
            content:
              "You are a browser automation repair specialist. " +
              "You receive a failed Playwright action and the current live page context, " +
              "and return a single corrected action in JSON. " +
              "Return ONLY valid JSON — no markdown, no explanation."
          },
          { role: "user", content: prompt }
        ]
      });

      const text = response.choices[0]?.message?.content?.trim() ?? "";
      const repairedAction = JSON.parse(text) as PlannedAction;

      // Basic sanity check — must be a valid action type
      const validActions = ["goto", "click", "fill", "press", "wait", "assert", "done"];
      if (!validActions.includes(repairedAction.action)) {
        logWarn(`[ActionHealer] LLM returned unknown action type: ${repairedAction.action}`);
        return null;
      }

      logInfo(`[ActionHealer] Repaired action: ${repairedAction.action}${repairedAction.target ? ` -> ${repairedAction.target}` : ""}${repairedAction.elementType ? ` [${repairedAction.elementType}]` : ""}`);
      return repairedAction;
    } catch (err) {
      logWarn(`[ActionHealer] Failed to parse LLM repair response: ${(err as Error).message}`);
      return null;
    }
  }

  private buildPrompt(
    failedAction: PlannedAction,
    error: string,
    pageContext: PlannerContext,
    stepDescription: string,
    completedActions: PlannedAction[]
  ): string {
    return `A browser automation action failed. Repair it.

## Original step
${stepDescription}

## Actions already completed successfully
${completedActions.length > 0
  ? JSON.stringify(completedActions, null, 2)
  : "(none — this was the first action)"}

## Failed action
${JSON.stringify(failedAction, null, 2)}

## Error
${error}

## Current page context (live snapshot — ${pageContext._stats.interactiveSent} interactive + ${pageContext._stats.contextSent} context elements)
URL: ${pageContext.url}
Title: ${pageContext.title}
Elements:
${JSON.stringify(pageContext.elements, null, 2)}

## Your task
Return a single corrected action JSON object that will achieve the same intent as the failed action.
Use only elements that exist in the current page context above.
Prefer stable locators: [name=...], [aria-label=...], [placeholder=...], text:..., role:button|...
Avoid locators with long numeric IDs (they are dynamically generated and will change).

Return ONLY this JSON structure — no markdown fences, no extra text:
{
  "action": "click | fill | press | wait | assert | goto | done",
  "target": "locator string",
  "value": "optional value",
  "valueKey": "optional dataset key",
  "elementType": "button | link | menuitem | input-text | input-autocomplete | input-password | select | dropdown | checkbox | radio | tab | accordion | table-row | label | other",
  "explanation": "what you changed and why"
}`;
  }
}
