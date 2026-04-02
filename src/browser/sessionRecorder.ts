import type { BrowserContext, Page } from "playwright";
import { ensureDir, writeJson } from "../utils/fs.js";

export interface RecordedBrowserEvent {
  at: string;
  type: "navigate" | "click" | "fill";
  url: string;
  title: string;
  details: Record<string, string>;
}

export async function attachSessionRecorder(_context: BrowserContext, page: Page, outputFile: string): Promise<void> {
  const events: RecordedBrowserEvent[] = [];

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      events.push({ at: new Date().toISOString(), type: "navigate", url: page.url(), title: "", details: {} });
      ensureDir(outputFile.split("/").slice(0, -1).join("/"));
      writeJson(outputFile, events);
    }
  });

  await page.exposeFunction("recordAgentEvent", (event: RecordedBrowserEvent) => {
    events.push(event);
    ensureDir(outputFile.split("/").slice(0, -1).join("/"));
    writeJson(outputFile, events);
  });

  await page.addInitScript(() => {
    const setup = () => {
      document.addEventListener("click", (evt) => {
        const t = evt.target as HTMLElement | null;
        if (!t) return;
        (window as any).recordAgentEvent?.({
          at: new Date().toISOString(),
          type: "click",
          url: location.href,
          title: document.title,
          details: {
            text: (t.innerText || t.textContent || "").trim(),
            tag: t.tagName,
            id: t.id || "",
            name: t.getAttribute("name") || "",
            ariaLabel: t.getAttribute("aria-label") || ""
          }
        });
      }, true);

      document.addEventListener("change", (evt) => {
        const t = evt.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
        if (!t) return;
        (window as any).recordAgentEvent?.({
          at: new Date().toISOString(),
          type: "fill",
          url: location.href,
          title: document.title,
          details: {
            value: "REDACTED",
            tag: t.tagName,
            id: t.id || "",
            name: t.getAttribute("name") || "",
            placeholder: t.getAttribute("placeholder") || "",
            ariaLabel: t.getAttribute("aria-label") || ""
          }
        });
      }, true);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup, { once: true });
    else setup();
  });
}
