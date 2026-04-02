import { Page } from "playwright";
import { detectHumanVerification } from "../detectors/detectHumanVerification.js";

export async function waitForManualVerificationToComplete(
  page: Page,
  originalUrl: string,
  timeoutMs = 180000
): Promise<"resolved" | "timeout"> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const currentUrl = page.url();

    if (currentUrl !== originalUrl) {
      return "resolved";
    }

    const stillBlocked = await detectHumanVerification(page);
    if (!stillBlocked) {
      return "resolved";
    }

    const passwordFieldVisible = await page
      .getByLabel("Enter your password", { exact: false })
      .isVisible()
      .catch(() => false);

    if (passwordFieldVisible) {
      return "resolved";
    }

    await page.waitForTimeout(1500);
  }

  return "timeout";
}