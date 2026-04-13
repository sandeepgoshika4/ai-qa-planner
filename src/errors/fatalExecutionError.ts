import type { Page } from "playwright";

/**
 * Thrown when a step fails due to a system-level error — e.g. HTTP 4xx/5xx,
 * network unreachable, service down.  These errors are not recoverable by
 * re-planning the action, so the ActionHealer should never be invoked.
 */
export class FatalExecutionError extends Error {
  constructor(
    message: string,
    /** The underlying cause (original Playwright / network error). */
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "FatalExecutionError";
  }
}

// ─── HTTP / network error detection ──────────────────────────────────────────

/** Matches a bare 4xx or 5xx status code anywhere in the message. */
const HTTP_STATUS_RE = /\b([45]\d{2})\b/;

/** Chromium / Playwright network-level error codes. */
const NET_ERR_RE =
  /net::(ERR_|CERT_)|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|ERR_ABORTED|ERR_FAILED/i;

/** Words that unambiguously point to a downstream service problem. */
const FATAL_PHRASE_RE =
  /internal server error|service unavailable|bad gateway|gateway timeout|too many requests|payment required|forbidden|unauthorized|not found/i;

/**
 * Common titles / headings rendered by web servers on error pages.
 * If the page title contains any of these we treat it as a fatal error.
 */
const ERROR_PAGE_TITLE_RE =
  /\b(404|403|401|500|502|503|504|400)\b|not found|server error|service unavailable|access denied|forbidden/i;

/**
 * Returns true when `errMsg` (or the live page state) indicates an HTTP or
 * network error that cannot be recovered by healing the Playwright action.
 *
 * @param errMsg  The `.message` of the caught error.
 * @param pageTitle  Optional current page title — used to detect error pages.
 */
export function isFatalError(errMsg: string, pageTitle?: string): boolean {
  if (HTTP_STATUS_RE.test(errMsg))   return true;
  if (NET_ERR_RE.test(errMsg))       return true;
  if (FATAL_PHRASE_RE.test(errMsg))  return true;
  if (pageTitle && ERROR_PAGE_TITLE_RE.test(pageTitle)) return true;
  return false;
}

// ─── Visible DOM error patterns ──────────────────────────────────────────────

/**
 * Text patterns that, when found in a *visible* element on the page,
 * indicate an unrecoverable system/API error.
 */
const DOM_ERROR_TEXT_RE =
  /system\s*error|service\s*(is\s*)?unavailable|something\s*went\s*wrong|api\s*(error|failure|failed)|downstream\s*service|server\s*error|internal\s*error|unexpected\s*error|application\s*error|oops[,!.\s]/i;

/**
 * Scan the live DOM for visible error banners, alerts, or messages that
 * indicate a system/API failure.  Angular and similar SPAs render these
 * as components inside the page rather than changing the page title.
 *
 * Returns the visible error text if found, or null if the page looks healthy.
 */
export async function detectPageError(page: Page): Promise<string | null> {
  try {
    return await page.evaluate((errorRe: string) => {
      const re = new RegExp(errorRe, "i");

      // Candidate containers: alert roles, common error CSS classes, dialogs
      const candidates = Array.from(document.querySelectorAll(
        '[role="alert"], [role="alertdialog"], [role="status"],' +
        '[class*="error"], [class*="Error"],' +
        '[class*="alert"], [class*="Alert"],' +
        '[class*="notification"], [class*="Notification"],' +
        '[class*="toast"], [class*="Toast"],' +
        '[class*="banner"], [class*="Banner"],' +
        '[class*="message"], [class*="Message"]'
      )) as HTMLElement[];

      for (const el of candidates) {
        // Only consider visually rendered elements
        const style = window.getComputedStyle(el);
        const rect  = el.getBoundingClientRect();
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0;

        if (!visible) continue;

        const text = (el.innerText || el.textContent || "").trim();
        if (text && re.test(text)) {
          // Return the first 200 chars so we don't flood the log
          return text.slice(0, 200);
        }
      }
      return null;
    }, DOM_ERROR_TEXT_RE.source);
  } catch {
    return null; // page navigate / context destroyed — non-fatal for this check
  }
}
