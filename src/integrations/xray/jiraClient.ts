import { env } from "../../config/env.js";
import { JiraIssueFields } from "../../types/jiraFields.js";

export class JiraClient {
  private authHeader(): string {
    // Use username/password from .env
    if (!env.jiraUsername || !env.jiraPassword) {
      throw new Error("JIRA_USERNAME / JIRA_PASSWORD are missing");
    }
    return `Basic ${Buffer.from(`${env.jiraUsername}:${env.jiraPassword}`).toString("base64")}`;
  }

  /**
   * Search issues by JQL and extract the first customfield_* whose value carries
   * a `steps` array (Xray test step custom field) — falls back to fields.steps.
   */
  async searchIssuesByJql(jql: string): Promise<JiraIssueFields> {
    if (!env.jiraBaseUrl) throw new Error("JIRA_BASE_URL is missing");
    const url = `${env.jiraBaseUrl}/rest/api/2/search?jql=${jql}&maxResults=50`;
    console.log(`Fetching for url: ${url}`);

    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: this.authHeader() }
    });
    if (!response.ok) {
      throw new Error(`Jira search failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const issues = data.issues || [];
    // Map only the first issue (JQL like `key=XYZ` should return the single issue)
    const issue = issues[0];
    if (!issue) {
      return {
        testName: "",
        steps: [],
        source: "jira",
        labels: []
      } as JiraIssueFields;
    }

    const fields = issue.fields || {};
    const stepsFieldKey = Object.keys(fields).find(
      (k) => k.startsWith("customfield_") && fields[k] && Array.isArray(fields[k].steps)
    );
    const rawSteps = stepsFieldKey ? fields[stepsFieldKey].steps : (fields.steps || []);

    const steps = Array.isArray(rawSteps)
      ? rawSteps.map((s: any, idx: number) => {
          const id = s.id != null ? String(s.id) : `step-${idx + 1}`;

          if (s && s.fields) {
            const fld = s.fields;
            const action = fld.Action || fld.action || fld.Description || fld.description || "";
            const rawData = fld.Data ?? fld.data ?? "";
            let data: any = rawData;
            if (typeof rawData === "string") {
              const candidate = rawData.trim().replace(/,\s*$/, "");
              if (candidate.includes(":")) {
                try {
                  data = JSON.parse(candidate.startsWith("{") ? candidate : `{${candidate}}`);
                } catch {
                  const lines = candidate.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                  const obj: Record<string, any> = {};
                  for (const line of lines) {
                    const idx2 = line.indexOf(":");
                    if (idx2 === -1) continue;
                    const key = line.slice(0, idx2).trim().replace(/^"|"$/g, "");
                    const val = line.slice(idx2 + 1).trim().replace(/^"|"$/g, "");
                    obj[key] = val;
                  }
                  data = obj;
                }
              } else {
                data = rawData;
              }
            } else if (rawData) {
              data = rawData;
            } else {
              data = "";
            }
            const expectedResult = fld["Expected Result"] || "";
            return { id, action, data, expectedResult };
          }

          const action = s.action || s.step || s.description || "";
          const data =
            typeof s.data === "string" ? s.data : s.data ? JSON.stringify(s.data) : "";
          const expectedResult = s.expectedResult || s.result || s.expected || "";
          return { id, action, data, expectedResult };
        })
      : [];

    const labels: string[] = Array.isArray(fields.labels) ? fields.labels : [];
    const summary = fields.summary || "";
    const description = fields.description || "";

    const mapped: JiraIssueFields = {
      testCaseKey: issue.key,
      testName: summary || issue.key,
      description,
      steps,
      source: "jira",
      labels,
      environment: fields.environment || ""
    };
    return mapped;
  }
}
