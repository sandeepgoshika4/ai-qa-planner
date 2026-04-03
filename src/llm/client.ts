import OpenAI from "openai";
import { env } from "../config/env.js";
import { logInfo } from "../utils/logger.js";

/**
 * Creates an OpenAI-compatible client based on the LLM_PROVIDER setting.
 *
 * - `LLM_PROVIDER=openai`  → direct OpenAI REST API (requires OPENAI_API_KEY)
 * - `LLM_PROVIDER=copilot` → VS Code Copilot proxy (requires the
 *    vscode-copilot-proxy extension running on LLM_PROXY_URL)
 */
export function makeLlmClient(): OpenAI {
  if (env.llmProvider === "copilot") {
    if (!env.llmProxyUrl) throw new Error("LLM_PROVIDER=copilot requires LLM_PROXY_URL to be set.");
    logInfo(`[LLM] Using VS Code Copilot proxy → ${env.llmProxyUrl}`);
    return new OpenAI({ apiKey: "copilot", baseURL: env.llmProxyUrl });
  }

  // Default: openai
  if (!env.openAiApiKey) throw new Error("LLM_PROVIDER=openai requires OPENAI_API_KEY to be set.");
  logInfo(`[LLM] Using OpenAI API (model: ${env.openAiModel})`);
  return new OpenAI({ apiKey: env.openAiApiKey });
}
