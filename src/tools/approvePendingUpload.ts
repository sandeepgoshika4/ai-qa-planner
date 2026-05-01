import { parseCliArgs } from "../config/cliArgs.js";
import { loadPendingUpload, savePendingUpload } from "../storage/pendingUploadStore.js";
import { logInfo } from "../utils/logger.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const file = args.approvePending ?? args.rejectPending;
  if (!file) throw new Error("Usage: npm run approve:upload -- <pending-file> --approve | --reject");

  const record = loadPendingUpload(file);
  if (args.rejectPending) {
    record.rejected = true;
    record.approved = false;
    record.note = "Rejected by operator after manual verification.";
    savePendingUpload(record);
    logInfo("Rejected.");
    return;
  }
  if (args.approvePending) {
    const client = new XrayClient();
    const response = await client.uploadExecutionResults(record.uploadPayload);
    record.approved = true;
    record.rejected = false;
    record.note = `Uploaded. Response: ${JSON.stringify(response)}`;
    savePendingUpload(record);
    logInfo("Approved and uploaded.");
    return;
  }
  throw new Error("Provide --approve or --reject");
}
main().catch((e) => { console.error(e); process.exit(1); });
