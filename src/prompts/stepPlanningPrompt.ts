export function buildStepPlanningPrompt(
  stepText: string,
  expectedResult: string | undefined,
  pageContext: any,
  dataKeys: string[]
): string {
  return `
You are an expert AI browser automation planner.

Convert the Jira/Xray manual test step into Playwright actions.

Return ONLY valid JSON in this exact format:

{
  "actions": [
    {
      "action": "goto | click | fill | press | wait | assert | done",
      "target": "optional locator",
      "value": "optional value",
      "valueKey": "optional dataset key",
      "explanation": "optional short explanation",
      "notes": "optional notes for logs or manual intervention",
      "stopExecution": true
    }
  ]
}

Rules:
- Only use elements that actually exist in the provided page context.
- Never invent fields or page elements.
- Prefer semantic locators like:
  - label:Email
  - placeholder:Search
  - text:Next
  - role:button|Login
  - selector:#identifierId
- Use valueKey for dataset values like username and password.
- If the page shows an unexpected security, authentication, bot-detection, unsupported-browser, access denied, captcha, or interstitial message, DO NOT continue normal automation.
- In such blocked situations, return an action with notes explaining the issue and set stopExecution to true.
- If the expected target field does not exist and the page clearly shows a blocking/error state, do not guess the next step.
- Always keep the plan minimal and valid.

Available dataset keys:
${JSON.stringify(dataKeys, null, 2)}

Manual step:
${stepText}

Expected result:
${expectedResult ?? "Not specified"}

Current page context:
${JSON.stringify(pageContext).slice(0, 8000)}
`;
}