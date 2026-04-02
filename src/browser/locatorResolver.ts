import type { Locator, Page } from "playwright";

export function resolveLocator(page: Page, target: string): Locator {
  const t = target.trim();
  if (t.startsWith("role:")) {
    const [, role, name] = t.split("|");
    return page.getByRole(role as any, name ? { name } : {});
  }
  if (t.startsWith("label:")) return page.getByLabel(t.replace(/^label:/, ""));
  if (t.startsWith("placeholder:")) return page.getByPlaceholder(t.replace(/^placeholder:/, ""));
  if (t.startsWith("text:")) return page.getByText(t.replace(/^text:/, ""), { exact: false });
  return page.locator(t);
}
