import { env } from "../config/env.js";
import { makeLlmClient } from "../llm/client.js";

export class StepGeneratorAgent {
  private client = makeLlmClient();

  async generateManualSteps(rawEvents: unknown): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: env.openAiModel,
      messages: [
        { role: "system", content: "Rewrite raw browser events into Jira/Xray manual test steps. Return markdown with numbered steps and sub-lines Action, Data, Expected result." },
        { role: "user", content: JSON.stringify(rawEvents, null, 2) }
      ]
    });
    return response.choices[0]?.message?.content?.trim() ?? "";
  }
}
