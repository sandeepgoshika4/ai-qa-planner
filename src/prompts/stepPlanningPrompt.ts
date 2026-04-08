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
      "elementType": "button | link | menuitem | input-text | input-autocomplete | input-password | select | dropdown | checkbox | radio | tab | accordion | table-row | label | other",
      "explanation": "optional short explanation",
      "notes": "optional notes for logs or manual intervention",
      "stopExecution": true
    }
  ]
}

Rules:
- Always include elementType for every action that has a target.
- Use elementType to describe the UI element being interacted with:
    button          → <button> or role=button
    link            → <a> tag, navigation link
    menuitem        → nav item, dropdown option, list item inside a menu
    input-text      → plain text input or textarea
    input-autocomplete → text input that shows dynamic suggestions after typing
    input-password  → password input
    select          → native <select> dropdown
    dropdown        → custom div/ul-based dropdown
    checkbox        → <input type=checkbox>
    radio           → <input type=radio>
    tab             → tab control (clicking reveals a panel)
    accordion       → expand/collapse section (clicking reveals child elements)
    table-row       → row in a data table
    label           → static label, heading, or text node
    other           → anything that doesn't fit above
- When a step combines multiple sub-actions (e.g. "click nav and then click Account"),
  emit one action per sub-action. The executor will discover newly revealed elements
  after each click — you do not need to know their exact locators in advance.
- Only use elements that actually exist in the provided page context.
- Never invent fields or page elements.
- Prefer semantic locators like:
    label:Email
    placeholder:Search
    text:Next
    role:button|Login
    selector:#identifierId
- Use valueKey for dataset values like username and password.
- If the page shows an unexpected security, authentication, bot-detection,
  unsupported-browser, access denied, captcha, or interstitial message,
  DO NOT continue normal automation. Return stopExecution: true with a note.
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
