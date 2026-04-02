import { Page } from "playwright";

export async function detectBlockedState(page: Page): Promise<string | null> {
  const bodyText = await page.locator("body").innerText().catch(() => "");

  const patterns = [
    "Couldn't sign you in",
    "This browser or app may not be secure",
    "Try using a different browser",
    "Access denied",
    "Verify it's you",
    "Suspicious activity",
    "captcha"
  ];

  const matched = patterns.find((p) =>
    bodyText.toLowerCase().includes(p.toLowerCase())
  );

  return matched ?? null;
}