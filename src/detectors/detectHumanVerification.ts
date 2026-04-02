import { Page } from "playwright";

export async function detectHumanVerification(page: Page): Promise<string | null> {
  const bodyText = await page.locator("body").innerText().catch(() => "");

  const patterns = [
    "captcha",
    "prove you are not a robot",
    "i'm not a robot",
    "verify you are human",
    "verify that it's you",
    "complete the captcha",
    "security challenge",
    "human verification",
    "unusual traffic",
    "please verify",
    "recaptcha"
  ];

  const match = patterns.find((pattern) =>
    bodyText.toLowerCase().includes(pattern.toLowerCase())
  );

  return match ?? null;
}