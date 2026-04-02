export interface XrayGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export interface XrayStepNode {
  id?: string;
  action?: string;
  data?: string;
  result?: string;
}

export interface XrayTestNode {
  issueId?: string;
  jira?: {
    key?: string;
    summary?: string;
    description?: string;
  };
  steps?: XrayStepNode[];
}

export interface XrayTestsQueryData {
  getTests?: {
    total?: number;
    results?: XrayTestNode[];
  };
}
