import fs from "node:fs/promises";
import path from "node:path";
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

  /**
   * Create a new Test Execution issue in the given project.
   * Returns the issue key (e.g. "FEWA-12345").
   */
  async createTestExecution(
    projectKey: string,
    summary: string,
    description?: string
  ): Promise<{ key: string }> {
    if (!env.jiraBaseUrl) throw new Error("JIRA_BASE_URL is missing");
    const url = `${env.jiraBaseUrl}/rest/api/2/issue`;

    const body = {
      fields: {
        project: { key: projectKey },
        summary,
        description: description ?? "",
        issuetype: { name: "Test Execution" }
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: this.authHeader()
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`Create Test Execution failed: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as { key: string };
    return { key: data.key };
  }

  /**
   * Link two issues using the standard Jira issueLink endpoint.
   * Default link type "Tests" matches Xray-enabled Jira instances; falls back
   * to "Relates" if the link type is unknown to the server.
   */
  async addIssueLink(
    fromKey: string,
    toKey: string,
    linkType: string = "Tests"
  ): Promise<void> {
    if (!env.jiraBaseUrl) throw new Error("JIRA_BASE_URL is missing");
    const url = `${env.jiraBaseUrl}/rest/api/2/issueLink`;

    const send = async (type: string): Promise<Response> =>
      fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: this.authHeader()
        },
        body: JSON.stringify({
          type: { name: type },
          inwardIssue: { key: toKey },
          outwardIssue: { key: fromKey }
        })
      });

    let response = await send(linkType);
    if (!response.ok && linkType !== "Relates") {
      // Retry with the universally-available "Relates" link type
      response = await send("Relates");
    }
    if (!response.ok) {
      throw new Error(`Issue link failed: ${response.status} ${await response.text()}`);
    }
  }

  /**
   * Attach a file from disk to a Jira issue. Uses multipart/form-data and the
   * required `X-Atlassian-Token: no-check` header.
   */
  async attachFile(issueKey: string, filePath: string): Promise<void> {
    if (!env.jiraBaseUrl) throw new Error("JIRA_BASE_URL is missing");
    const url = `${env.jiraBaseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`;

    const buf = await fs.readFile(filePath);
    const blob = new Blob([buf]);
    const form = new FormData();
    form.append("file", blob, path.basename(filePath));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: this.authHeader(),
        "X-Atlassian-Token": "no-check"
      },
      body: form
    });
    if (!response.ok) {
      throw new Error(`Attach file failed: ${response.status} ${await response.text()}`);
    }
  }
}
