import fs from "node:fs";
import path from "node:path";
import type { ManualTestCase } from "../types/manualTest.js";

export function loadManualTestFile(filePath: string): ManualTestCase {
  const full = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(full, "utf-8")) as ManualTestCase;
}
