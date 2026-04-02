import { parseCliArgs } from "../config/cliArgs.js";
import { XrayClient } from "../integrations/xray/xrayClient.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.xrayIssue && !args.xrayJql) throw new Error("Pass --xray-issue or --xray-jql");
  const client = new XrayClient();
  const data = args.xrayIssue ? await client.fetchTestsByIssueKey(args.xrayIssue) : await client.fetchTestsByJql(args.xrayJql!);
  console.log(JSON.stringify(data, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
