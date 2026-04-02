import path from "node:path";
import type { StepPlan } from "../types/planner.js";
import { ensureDir, readJson, slugify, writeJson } from "../utils/fs.js";

const baseDir = ensureDir(path.resolve("out/plans"));
const toPath = (domain: string, step: string) => path.join(baseDir, `${slugify(domain)}__${slugify(step)}.json`);

export function loadCachedStepPlan(domain: string, stepAction: string): StepPlan | null {
  try { return readJson<StepPlan>(toPath(domain, stepAction)); } catch { return null; }
}
export function saveCachedStepPlan(domain: string, stepAction: string, plan: StepPlan): void {
  writeJson(toPath(domain, stepAction), plan);
}
