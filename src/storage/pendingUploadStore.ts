import path from "node:path";
import type { PendingUploadRecord } from "../types/run.js";
import { ensureDir, readJson, writeJson } from "../utils/fs.js";
const baseDir = ensureDir(path.resolve("out/pending-uploads"));
export const savePendingUpload = (record: PendingUploadRecord): string => {
  const file = path.join(baseDir, `${record.pendingId}.json`);
  writeJson(file, record);
  return file;
};
export const loadPendingUpload = (filePath: string): PendingUploadRecord => readJson<PendingUploadRecord>(path.resolve(filePath));
