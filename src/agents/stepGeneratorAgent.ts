import OpenAI from "openai";
import { env } from "../config/env.js";

function makeClient(): OpenAI {
  if (env.llmProxyUrl) {
    return new OpenAI({ apiKey: "copilot", baseURL: env.llmProxyUrl });
  }
  if (!env.openAiApiKey) throw new Error("Either LLM_PROXY_URL or OPENAI_API_KEY must be set");
  return new OpenAI({ apiKey: env.openAiApiKey });
}

export class StepGeneratorAgent {
  private client: OpenAI;
  constructor() {
    this.client = makeClient();
  }

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
