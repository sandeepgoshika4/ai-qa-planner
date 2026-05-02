export interface CliOptions {
  file?: string;

  jiraIssue?: string;
  resume?: string;
  rejectPending?: string;
  recordingFile?: string;
  /** When true, skip per-step prompts and run all steps automatically. */
  auto?: boolean;
  /** When true, upload a Jira Test Execution after the run passes. */
  approve?: boolean;
}
export function parseCliArgs(argv: string[]): CliOptions {
  const out: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = argv[i+1];
    if (arg === "--file") out.file = next;
    if (arg === "--jira-issue") out.jiraIssue = next;
    if (arg === "--resume") out.resume = next;
    if (arg === "--approve") out.approve = true;
    if (arg === "--reject") out.rejectPending = next;
    if (arg === "--auto") out.auto = true;
    if (!arg.startsWith("--") && !out.recordingFile) out.recordingFile = arg;
  }
  return out;
}
