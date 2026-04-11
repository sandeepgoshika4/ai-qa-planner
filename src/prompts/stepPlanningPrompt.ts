import type { PlannerContext } from "../browser/pageContextFilter.js";

export function buildStepPlanningPrompt(
  stepText: string,
  expectedResult: string | undefined,
  pageContext: PlannerContext,
  dataKeys: string[]
): string {
  return `
You are an expert AI browser automation planner.

Convert the Jira/Xray manual test step into Playwright actions.

Return ONLY valid JSON in this exact format:

{
  "actions": [
    {
      "action": "goto | click | fill | selectOption | press | wait | assert | done",
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
    select          → native <select> dropdown  ← use action: "selectOption" (NOT fill)
    dropdown        → custom div/ul-based dropdown  ← use action: "click" to open, then "click" the option
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
- For native <select> elements (elementType: "select"), ALWAYS use action: "selectOption" with the visible option label as the value. Never use "fill" on a <select>.
- For custom dropdowns (elementType: "dropdown"), use action: "click" to open the dropdown, then action: "click" on the desired option.
- Use valueKey for dataset values like username and password.
- If the page shows an unexpected security, authentication, bot-detection,
  unsupported-browser, access denied, captcha, or interstitial message,
  DO NOT continue normal automation. Return stopExecution: true with a note.
- assert actions MUST always have a target — never emit an assert without one. If you cannot identify a specific element to assert, omit the assert entirely.
- HOW TO END A STEP — always finish your plan with these two actions in order:
    1. assert  → verify the expected result is visible on the page.
               Use a specific element from the page context that confirms the step succeeded
               (e.g. a success message, a new page heading, a field that changed value).
               If no useful assertion target exists, skip the assert.
    2. done    → signals the step is complete. ALWAYS include this as the final action.
               No target, no value needed: { "action": "done" }
  Never omit the done action. It tells the runner the step finished successfully.
- Elements in the page context may include a "checked" field (radio/checkbox) and "currentValue" field (inputs/selects).
  Before generating a click/fill for a radio, checkbox, or select:
    • If a radio is already checked (checked: true) and the step wants it selected — SKIP the action.
    • If a checkbox already matches the desired state — SKIP the action.
    • If an input already contains the required value — SKIP the fill action.
  Never click a radio or checkbox that is already in the desired state.
- Some elements have "visible": false — these are CONDITIONAL fields that are currently hidden
  but will appear automatically after you interact with a trigger element (e.g. selecting a value
  from a dropdown reveals a dependent input). You SHOULD still plan actions for these elements.
  The executor will wait for them to become visible before interacting with them.
  Do NOT skip or omit actions targeting visible:false elements.
- Always keep the plan minimal and valid.

Available dataset keys:
${JSON.stringify(dataKeys, null, 2)}

Manual step:
${stepText}

Expected result (use this to write the assert action — find a visible element that confirms this outcome):
${expectedResult ?? "Not specified"}

Current page context (${pageContext._stats.interactiveSent} interactive + ${pageContext._stats.contextSent} context elements; ${pageContext._stats.totalExtracted} total on page):
URL: ${pageContext.url}
Title: ${pageContext.title}
Elements:
${JSON.stringify(pageContext.elements, null, 2)}
`;
}
