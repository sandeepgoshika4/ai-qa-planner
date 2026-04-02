import type { Page } from "playwright";
import type { PageContext } from "../types/pageContext.js";

export async function extractPageContext(page: Page): Promise<PageContext> {
  const title = await page.title();
  const url = page.url();
  const dom = await page.content();
  const elements = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('input, button, a, select, textarea, [role="button"], [role="link"], [contenteditable="true"]'));
    return nodes.map((node, index) => {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      const id = el.getAttribute("id");
      const name = el.getAttribute("name");
      const aria = el.getAttribute("aria-label");
      const placeholder = el.getAttribute("placeholder");
      let selector = tag;
      if (id) selector = `#${id}`;
      else if (name) selector = `${tag}[name="${name}"]`;
      else if (aria) selector = `${tag}[aria-label="${aria}"]`;
      else if (placeholder) selector = `${tag}[placeholder="${placeholder}"]`;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        elementId: `el_${index + 1}`,
        tag: el.tagName,
        text: (el.innerText || el.textContent || "").trim(),
        name,
        idAttr: id,
        placeholder,
        ariaLabel: aria,
        role: el.getAttribute("role"),
        href: el.getAttribute("href"),
        selector,
        visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
        enabled: !el.hasAttribute("disabled")
      };
    });
  });
  return { url, title, dom, elements };
}
