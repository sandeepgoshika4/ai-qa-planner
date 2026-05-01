import { parseCliArgs } from "../config/cliArgs.js";
import { loadPendingUpload, savePendingUpload } from "../storage/pendingUploadStore.js";
import { logInfo } from "../utils/logger.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const file = args.rejectPending;
  if (!file) throw new Error("Usage: npm run approve:upload -- <pending-file> --reject");

  const record = loadPendingUpload(file);
  if (args.rejectPending) {
    record.rejected = true;
    record.approved = false;
    record.note = "Rejected by operator after manual verification.";
    savePendingUpload(record);
    logInfo("Rejected.");
    return;
  }
  throw new Error("Provide --reject");
}
main().catch((e) => { console.error(e); process.exit(1); });
