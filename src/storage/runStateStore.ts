import path from "node:path";
import type { RunState } from "../types/run.js";
import { ensureDir, readJson, writeJson } from "../utils/fs.js";
const baseDir = ensureDir(path.resolve("out/run-states"));
export const saveRunState = (state: RunState): string => {
  const file = path.join(baseDir, `${state.runId}.json`);
  writeJson(file, state);
  return file;
};
export const loadRunState = (filePath: string): RunState => readJson<RunState>(path.resolve(filePath));
