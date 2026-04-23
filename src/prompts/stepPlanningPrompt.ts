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
      "stopExecution": true,
      "blind": false
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
- HOW TO WRITE ASSERT TARGETS:
    • For verifying DISPLAYED TEXT VALUES (e.g. a read-only email address, a status like "Text Message",
      a name, a dollar amount shown on screen) — use the "text:" prefix:
        { "action": "assert", "target": "text:Text Message", "elementType": "label" }
        { "action": "assert", "target": "text:SANDEEP.GOSHIKA@FMR.COM", "elementType": "label" }
      This checks that the text is visible anywhere on the page — no specific element needed.
    • For verifying a PAGE HEADING or TITLE visible on screen — use "text:" or a heading selector:
        { "action": "assert", "target": "text:Review", "elementType": "label" }
    • For verifying an INPUT has a value — use the input's selector with currentValue in mind.
    • NEVER set "blind": true on an assert action. If the value to verify is not in the page context,
      use "text:<exact visible text>" as the target — the executor will check page visibility directly.
    • Be careful with error messages and warning banners:
        - If the EXPECTED RESULT explicitly says the page should show a validation
          error or warning (e.g. "field is required", "invalid date", "must not be empty"),
          then asserting on that error text IS correct — it confirms the step succeeded.
          Example: { "action": "assert", "target": "text:This field is required", "elementType": "label" }
        - If the expected result says nothing about an error but the page context already
          contains error text (a pre-existing banner unrelated to this step), do NOT
          use that error text as the assert target. Pick a success indicator instead,
          or skip the assert entirely.
    • NEVER use elementType "input-text" for an assert unless you are asserting on a form input field.
      Use elementType "label" for any read-only displayed text.
- HOW TO END A STEP — always finish your plan with these two actions in order:
    1. assert  → verify the expected result is visible on the page.
               Use a specific element from the page context that confirms the step SUCCEEDED
               (e.g. a new page heading, a section label, a success banner, a changed field value).
               NEVER use error messages or warning text as the assert target — even if they
               are visible in the page context. If no success indicator exists, skip the assert.
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
- BLIND ACTIONS — If the step text mentions a field or element that does NOT exist in the
  provided page context, it is likely a CONDITIONAL/DYNAMIC field that will appear at runtime
  after an earlier action (e.g. selecting a dropdown value reveals a dependent input, clicking
  a toggle shows hidden fields, or clicking a radio reveals additional options).
  Still plan the action and set "blind": true. Use the field label/name from the step text as
  the target (e.g. "Source of Income", "Spouse Name"). The executor will re-extract the page
  after earlier actions have executed and resolve the correct selector at runtime.
  This applies to fill, click, selectOption, press ONLY — NEVER use blind: true on assert.
  For assert, always use "text:<visible value>" instead.
  Examples of blind actions:
    { "action": "fill", "target": "Source of Income", "value": "Pension", "elementType": "input-text", "blind": true }
    { "action": "click", "target": "Spouse Info", "elementType": "checkbox", "blind": true }
    { "action": "selectOption", "target": "Sub Category", "value": "Option A", "elementType": "select", "blind": true }
- IMPORTANT: Every distinct sub-action mentioned in the step text MUST appear in your plan.
  If the step says "fill X, select Y, and click Add", your plan MUST include actions for ALL
  of them — do not stop early or omit trailing actions. Use blind: true for fields not in context.
- Always keep the plan minimal and valid.

Available dataset keys:
${JSON.stringify(dataKeys, null, 2)}

Manual step:
${stepText}

Expected result (use this to write the assert action — find a visible element that confirms this outcome):
${expectedResult ?? "Not specified"}

Current page context (${pageContext._stats.interactiveSent} interactive + ${pageContext._stats.contextSent} context + ${pageContext._stats.displaySent} display values; ${pageContext._stats.totalExtracted} total on page):
URL: ${pageContext.url}
Title: ${pageContext.title}
Elements:
${JSON.stringify(pageContext.elements, null, 2)}
`;
}
