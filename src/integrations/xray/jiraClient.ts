import { env } from "../../config/env.js";

export class JiraClient {
  private authHeader(): string {
    if (!env.jiraEmail || !env.jiraApiToken) throw new Error("JIRA_EMAIL / JIRA_API_TOKEN are missing");
    return `Basic ${Buffer.from(`${env.jiraEmail}:${env.jiraApiToken}`).toString("base64")}`;
  }

  async searchIssuesByJql(jql: string): Promise<unknown> {
    if (!env.jiraBaseUrl) throw new Error("JIRA_BASE_URL is missing");
    const response = await fetch(`${env.jiraBaseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=50`, {
      headers: { Accept: "application/json", Authorization: this.authHeader() }
    });
    if (!response.ok) throw new Error(`Jira search failed: ${response.status} ${await response.text()}`);
    return response.json();
  }
}
