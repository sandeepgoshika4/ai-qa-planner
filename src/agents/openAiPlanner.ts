import OpenAI from "openai";
import { env } from "../config/env.js";
import { buildStepPlanningPrompt } from "../prompts/stepPlanningPrompt.js";
import type { ManualTestStep } from "../types/manualTest.js";
import type { PageContext } from "../types/pageContext.js";
import type { StepPlan } from "../types/planner.js";

function makeClient(): OpenAI {
  if (env.llmProxyUrl) {
    return new OpenAI({ apiKey: "copilot", baseURL: env.llmProxyUrl });
  }
  if (!env.openAiApiKey) throw new Error("Either LLM_PROXY_URL or OPENAI_API_KEY must be set");
  return new OpenAI({ apiKey: env.openAiApiKey });
}

export class OpenAiPlanner {
  private client: OpenAI;
  constructor() {
    this.client = makeClient();
  }

  async planStep(step: ManualTestStep, page: PageContext, dataSet: Record<string, string>): Promise<StepPlan> {
    const response = await this.client.chat.completions.create({
      model: env.openAiModel,
      messages: [
        { role: "system", content: buildStepPlanningPrompt(step.action, step.expectedResult, page, Object.keys(dataSet)) },
        {
          role: "user",
          content: JSON.stringify({
            manualStep: step,
            dataKeys: Object.keys(dataSet),
            page: {
              url: page.url,
              title: page.title,
              elements: page.elements.filter((e) => e.visible).slice(0, 80)
            }
          }, null, 2)
        }
      ]
    });
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(text) as { actions: StepPlan["actions"] };
    return { manualStepId: step.id, manualStepAction: step.action, actions: parsed.actions.slice(0, env.maxAgentActionsPerStep) };
  }
}
