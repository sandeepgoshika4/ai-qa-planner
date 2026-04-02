import * as vscode from "vscode";
import * as http from "http";

const PORT = 3100;
let server: http.Server | undefined;

// Maps the model name sent by the caller to a vscode.lm family string.
// Adjust entries here if VS Code reports different family IDs for your tenant.
function resolveFamily(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "claude-opus-4-6";
  if (lower.includes("sonnet")) return "claude-sonnet-4-6";
  // Pass everything else (gpt-5.x, etc.) through as-is
  return model;
}

// Converts an OpenAI-style messages array to vscode.LanguageModelChatMessage[].
// System messages are folded into the following user message (or a synthetic one).
function toVscodeLmMessages(
  messages: Array<{ role: string; content: string }>
): vscode.LanguageModelChatMessage[] {
  const result: vscode.LanguageModelChatMessage[] = [];
  let pendingSystem = "";

  for (const msg of messages) {
    if (msg.role === "system") {
      pendingSystem += (pendingSystem ? "\n" : "") + msg.content;
    } else if (msg.role === "user") {
      const content = pendingSystem
        ? `[System instructions]\n${pendingSystem}\n\n[User]\n${msg.content}`
        : msg.content;
      result.push(vscode.LanguageModelChatMessage.User(content));
      pendingSystem = "";
    } else if (msg.role === "assistant") {
      result.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
    }
  }

  // If there were only system messages with no following user message
  if (pendingSystem) {
    result.push(vscode.LanguageModelChatMessage.User(`[System instructions]\n${pendingSystem}`));
  }

  return result;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Only POST /v1/chat/completions is supported" }));
    return;
  }

  const body = await new Promise<string>((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  let payload: { model?: string; messages?: Array<{ role: string; content: string }> };
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  const { model = "claude-sonnet-4-6", messages = [] } = payload;
  const family = resolveFamily(model);

  const candidates = await vscode.lm.selectChatModels({ vendor: "copilot", family });
  const lmModel = candidates[0];

  if (!lmModel) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `No Copilot model found for family "${family}". Available models may differ — check vscode.lm.selectChatModels() output.` }));
    return;
  }

  const lmMessages = toVscodeLmMessages(messages);
  const cts = new vscode.CancellationTokenSource();

  let text = "";
  try {
    const response = await lmModel.sendRequest(lmMessages, {}, cts.token);
    for await (const chunk of response.text) {
      text += chunk;
    }
  } catch (err: unknown) {
    cts.dispose();
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
    return;
  }

  cts.dispose();

  const result = {
    id: `chatcmpl-proxy-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: lmModel.id,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

function startServer(context: vscode.ExtensionContext): void {
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
    });
  });

  server.listen(PORT, "127.0.0.1", () => {
    vscode.window.showInformationMessage(`Copilot LLM Proxy listening on http://localhost:${PORT}`);
  });

  server.on("error", (err) => {
    vscode.window.showErrorMessage(`Copilot LLM Proxy error: ${err.message}`);
  });

  context.subscriptions.push({ dispose: () => server?.close() });
}

export function activate(context: vscode.ExtensionContext): void {
  startServer(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("copilot-llm-proxy.status", () => {
      const state = server?.listening ? `running on port ${PORT}` : "not running";
      vscode.window.showInformationMessage(`Copilot LLM Proxy is ${state}`);
    })
  );
}

export function deactivate(): void {
  server?.close();
}
