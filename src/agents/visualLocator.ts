import type { Page } from "playwright";
import { env } from "../config/env.js";
import { makeLlmClient } from "../llm/client.js";
import type { PlannedAction } from "../types/planner.js";
import { logInfo, logWarn } from "../utils/logger.js";

// ─── Result types ─────────────────────────────────────────────────────────────

export type VisualResult =
  | { type: "coordinates"; x: number; y: number; explanation: string }
  | { type: "selector"; selector: string; explanation: string };

// ─── VisualLocator ────────────────────────────────────────────────────────────

/**
 * Last-resort element locator that takes a full-page screenshot and asks a
 * vision-capable LLM to identify where the target element is.
 *
 * Returns either:
 *  - Pixel coordinates  → executor calls page.mouse.click(x, y)
 *  - A stable selector  → executor updates resolved[i].target and retries
 *  - null               → LLM could not find the element
 *
 * Enable with VISUAL_LOCATOR_ENABLED=true.
 * The vision model is controlled by VISION_MODEL (default: gpt-4o).
 */
export class VisualLocator {
  private client = makeLlmClient();

  async locate(
    page: Page,
    action: PlannedAction,
    stepDescription: string
  ): Promise<VisualResult | null> {
    logInfo(`[VisualLocator] Taking screenshot for visual element location...`);

    // Capture a JPEG screenshot — smaller payload than PNG, good enough for LLM
    let screenshotBase64: string;
    try {
      const buffer = await page.screenshot({ type: "jpeg", quality: 75, fullPage: false });
      screenshotBase64 = buffer.toString("base64");
    } catch (err) {
      logWarn(`[VisualLocator] Could not take screenshot: ${(err as Error).message}`);
      return null;
    }

    const prompt = this.buildPrompt(action, stepDescription);

    try {
      const response = await this.client.chat.completions.create({
        model: env.visionModel,
        messages: [
          {
            role: "system",
            content:
              "You are a visual browser automation assistant. " +
              "You look at screenshots and identify UI elements by their visual position. " +
              "Return ONLY valid JSON — no markdown, no explanation outside the JSON."
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${screenshotBase64}`,
                  detail: "high"
                }
              }
            ]
          }
        ],
        max_tokens: 300
      });

      const raw = response.choices[0]?.message?.content?.trim() ?? "";

      // Strip markdown fences if present
      const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const result = JSON.parse(json) as {
        type: "coordinates" | "selector" | "not_found";
        x?: number;
        y?: number;
        selector?: string;
        explanation: string;
      };

      if (result.type === "not_found") {
        logWarn(`[VisualLocator] Element not found in screenshot: ${result.explanation}`);
        return null;
      }

      if (result.type === "coordinates" && typeof result.x === "number" && typeof result.y === "number") {
        logInfo(`[VisualLocator] Found element at coordinates (${result.x}, ${result.y}) — ${result.explanation}`);
        return { type: "coordinates", x: result.x, y: result.y, explanation: result.explanation };
      }

      if (result.type === "selector" && typeof result.selector === "string" && result.selector.trim()) {
        logInfo(`[VisualLocator] Found element via selector "${result.selector}" — ${result.explanation}`);
        return { type: "selector", selector: result.selector.trim(), explanation: result.explanation };
      }

      logWarn(`[VisualLocator] Unexpected response shape: ${raw}`);
      return null;

    } catch (err) {
      logWarn(`[VisualLocator] Vision LLM call failed: ${(err as Error).message}`);
      return null;
    }
  }

  private buildPrompt(action: PlannedAction, stepDescription: string): string {
    const elementDesc = [
      action.elementType ? `Type: ${action.elementType}` : null,
      action.target       ? `Expected selector/label: ${action.target}` : null,
      action.value        ? `Expected value/text: ${action.value}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return `I am automating a browser test. The following action failed because the selector did not match any visible element.

## Step being executed
${stepDescription}

## Failed action
Action: ${action.action}
${elementDesc}
${action.explanation ? `Explanation: ${action.explanation}` : ""}

## Your task
Look at the screenshot and find this element visually.

Respond with EXACTLY one of these JSON shapes:

1. If you can identify the element's pixel position on screen:
{
  "type": "coordinates",
  "x": <center X pixel of the element>,
  "y": <center Y pixel of the element>,
  "explanation": "<short description of what you found>"
}

2. If you can determine a reliable CSS/attribute selector from what you see in the HTML source visible in the screenshot:
{
  "type": "selector",
  "selector": "<CSS or attribute selector>",
  "explanation": "<short description>"
}

3. If you cannot find the element at all:
{
  "type": "not_found",
  "explanation": "<why you couldn't find it>"
}

Rules:
- Prefer coordinates when the element is clearly visible but the selector was wrong.
- Prefer selector only if you can see a stable attribute (aria-label, placeholder, text content).
- Never guess — return not_found if you are unsure.
- Return ONLY the JSON object, no extra text.`;
  }
}
