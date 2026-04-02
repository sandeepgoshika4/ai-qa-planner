import fs from "node:fs";
import { StepGeneratorAgent } from "../agents/stepGeneratorAgent.js";
import { parseCliArgs } from "../config/cliArgs.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const file = args.recordingFile;
  if (!file) throw new Error("Usage: npm run generate:steps -- <recording.json>");
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  const agent = new StepGeneratorAgent();
  const output = await agent.generateManualSteps(raw);
  console.log(output);
}
main().catch((e) => { console.error(e); process.exit(1); });
