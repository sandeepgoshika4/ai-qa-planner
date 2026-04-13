import { env } from "../config/env.js";
import { makeLlmClient } from "../llm/client.js";
import { buildStepPlanningPrompt } from "../prompts/stepPlanningPrompt.js";
import { filterPageContext } from "../browser/pageContextFilter.js";
import type { ManualTestStep } from "../types/manualTest.js";
import type { PageContext } from "../types/pageContext.js";
import type { StepPlan } from "../types/planner.js";
import { logInfo, logWarn } from "../utils/logger.js";

export class OpenAiPlanner {
  private client = makeLlmClient();

  async planStep(step: ManualTestStep, page: PageContext, dataSet: Record<string, string>): Promise<StepPlan> {
    const filtered = filterPageContext(page);
    logInfo(
      `[Planner] Page context: ${filtered._stats.totalExtracted} total → ` +
      `${filtered._stats.interactiveSent} interactive + ` +
      `${filtered._stats.contextSent} context + ` +
      `${filtered._stats.conditionalSent} conditional(hidden) sent to LLM`
    );

    const response = await this.client.chat.completions.create({
      model: env.openAiModel,
      messages: [
        {
          role: "system",
          content: buildStepPlanningPrompt(step.action, step.expectedResult, filtered, Object.keys(dataSet))
        },
        {
          role: "user",
          content: JSON.stringify({
            manualStep: step,
            dataKeys: Object.keys(dataSet),
            page: filtered
          }, null, 2)
        }
      ]
    });

    const text = response.choices[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(text) as { actions: StepPlan["actions"] };

    if (parsed.actions.length > env.maxAgentActionsPerStep) {
      logWarn(
        `[Planner] ⚠ Truncating ${parsed.actions.length} actions to ${env.maxAgentActionsPerStep} ` +
        `(increase MAX_AGENT_ACTIONS_PER_STEP to allow more)`
      );
    }

    return {
      manualStepId: step.id,
      manualStepAction: step.action,
      actions: parsed.actions.slice(0, env.maxAgentActionsPerStep)
    };
  }
}
