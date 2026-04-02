import { env } from "../../config/env.js";
import type { XrayGraphQLResponse, XrayTestsQueryData } from "../../types/xray.js";

export class XrayClient {
  private token: string | null = null;

  private async authenticate(): Promise<string> {
    if (this.token) return this.token;
    if (!env.xrayClientId || !env.xrayClientSecret) {
      throw new Error("XRAY_CLIENT_ID / XRAY_CLIENT_SECRET are missing");
    }
    const response = await fetch(`${env.xrayBaseUrl}/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: env.xrayClientId, client_secret: env.xrayClientSecret })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Xray auth failed: ${response.status} ${text}`);
    this.token = text.replace(/^"|"$/g, "");
    return this.token;
  }

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const token = await this.authenticate();
    const response = await fetch(env.xrayGraphqlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables })
    });
    const data = await response.json() as XrayGraphQLResponse<T>;
    if (!response.ok || data.errors?.length) throw new Error(`Xray GraphQL failed: ${JSON.stringify(data.errors ?? data)}`);
    if (!data.data) throw new Error("Xray GraphQL returned no data");
    return data.data;
  }

  async fetchTestsByJql(jql: string): Promise<XrayTestsQueryData> {
    const query = `
      query GetTests($jql: String!) {
        getTests(jql: $jql, limit: 100) {
          total
          results {
            issueId
            jira(fields: ["key","summary","description"])
            steps {
              id
              action
              data
              result
            }
          }
        }
      }
    `;
    return this.graphql<XrayTestsQueryData>(query, { jql });
  }

  async fetchTestsByIssueKey(issueKey: string): Promise<XrayTestsQueryData> {
    return this.fetchTestsByJql(`key = "${issueKey}"`);
  }

  async uploadExecutionResults(payload: unknown): Promise<unknown> {
    const token = await this.authenticate();
    const response = await fetch(`${env.xrayBaseUrl}/import/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Xray upload failed: ${response.status} ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  }
}
