import dotenv from "dotenv";
dotenv.config();

const parseBool = (name: string, fallback: boolean): boolean => {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v.toLowerCase() === "true";
};
const parseNum = (name: string, fallback: number): number => {
  const v = process.env[name];
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const env = {
  headless: parseBool("HEADLESS", false),
  slowMo: parseNum("SLOW_MO", 500),
  stepDelayMs: parseNum("STEP_DELAY_MS", 400),
  keepBrowserOpen: parseBool("KEEP_BROWSER_OPEN", false),
  maxAgentActionsPerStep: parseNum("MAX_AGENT_ACTIONS_PER_STEP", 8),
  maxPlannerElements: parseNum("MAX_PLANNER_ELEMENTS", 60),
  healMaxAttempts: parseNum("HEAL_MAX_ATTEMPTS", 2),
  visualLocatorEnabled: parseBool("VISUAL_LOCATOR_ENABLED", false),
  visionModel: process.env.VISION_MODEL ?? "gpt-4o",
  llmProvider: (process.env.LLM_PROVIDER ?? "openai") as "openai" | "copilot",
  watcherLogging: parseBool("WATCHER_LOGGING", true),
  watcherSettleMs: parseNum("WATCHER_SETTLE_MS", 800),
  openAiApiKey: process.env.OPENAI_API_KEY ?? "",
  openAiModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  llmProxyUrl: process.env.LLM_PROXY_URL ?? "http://localhost:3100/v1",
  xrayClientId: process.env.XRAY_CLIENT_ID ?? "",
  xrayClientSecret: process.env.XRAY_CLIENT_SECRET ?? "",
  xrayBaseUrl: process.env.XRAY_BASE_URL ?? "https://xray.cloud.getxray.app/api/v2",
  xrayGraphqlUrl: process.env.XRAY_GRAPHQL_URL ?? "https://xray.cloud.getxray.app/api/v2/graphql",
  jiraBaseUrl: process.env.JIRA_BASE_URL ?? "",
  jiraEmail: process.env.JIRA_EMAIL ?? "",
  jiraApiToken: process.env.JIRA_API_TOKEN ?? ""
};
