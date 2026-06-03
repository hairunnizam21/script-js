// Minimal OpenAI-compatible chat client using only the Node stdlib (global
// `fetch`, available since Node 18). No npm dependencies, so install stays
// trivial on Termux and servers.
//
// Supports POST /chat/completions with `tools` (function calling), both
// streaming (SSE) and non-streaming, plus transient-failure retries.

export class APIError extends Error {
  constructor(message, status = null, body = "") {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.body = body;
  }
}

export class ChatClient {
  constructor({ baseUrl, apiKey, timeout = 300000 }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.apiKey = apiKey || "";
    this.timeout = timeout;
  }

  // Allow swapping API config at runtime (/setapi command).
  reconfigure({ baseUrl, apiKey } = {}) {
    if (baseUrl) this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    if (apiKey !== undefined) this.apiKey = apiKey;
  }

  _headers() {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "suzu-js/1.0",
    };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async _post(path, payload) {
    const url = `${this.baseUrl}${path}`;
    const body = JSON.stringify(payload);
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: this._headers(),
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
          let text = "";
          try {
            text = await resp.text();
          } catch {
            /* ignore */
          }
          // 4xx is not retryable.
          if (resp.status >= 400 && resp.status < 500) {
            throw new APIError(
              `HTTP ${resp.status} from ${url}: ${text.slice(0, 400)}`,
              resp.status,
              text,
            );
          }
          lastErr = new APIError(
            `HTTP ${resp.status} from ${url}: ${text.slice(0, 400)}`,
            resp.status,
            text,
          );
        } else {
          return resp;
        }
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof APIError && e.status >= 400 && e.status < 500) throw e;
        lastErr = e;
      }
      await sleep(1500 * (attempt + 1));
    }
    throw new APIError(`Network error contacting ${url}: ${lastErr}`);
  }

  // Non-streaming completion. Returns the parsed JSON response.
  async chat(req) {
    const payload = buildPayload(req, false);
    const resp = await this._post("/chat/completions", payload);
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new APIError(`Invalid JSON from server: ${e}; body=${raw.slice(0, 400)}`);
    }
  }

  // Streaming completion. Calls onDelta(deltaObj) for each chunk's
  // `choices[0].delta`. Returns when the stream ends.
  async stream(req, onDelta) {
    const payload = buildPayload(req, true);
    const resp = await this._post("/chat/completions", payload);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const data = line.startsWith("data:") ? line.slice(5).trim() : line;
        if (!data || data === "[DONE]") {
          if (data === "[DONE]") return;
          continue;
        }
        let obj;
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = obj?.choices?.[0]?.delta;
        if (delta) onDelta(delta);
      }
    }
  }
}

function buildPayload(req, stream) {
  const payload = {
    model: req.model,
    messages: req.messages,
    stream,
  };
  if (req.tools && req.tools.length) {
    payload.tools = req.tools;
    if (req.toolChoice != null) payload.tool_choice = req.toolChoice;
  }
  if (req.temperature != null) payload.temperature = req.temperature;
  if (req.maxTokens) payload.max_tokens = req.maxTokens;
  if (req.extra) Object.assign(payload, req.extra);
  return payload;
}

// Accumulates streamed deltas into a single assistant message, assembling
// partial tool_calls (which arrive fragmented across chunks) by index.
export class DeltaAccumulator {
  constructor() {
    this.content = "";
    this.toolCalls = []; // [{id, type, function:{name, arguments}}]
  }

  push(delta) {
    let added = "";
    if (typeof delta.content === "string" && delta.content) {
      this.content += delta.content;
      added = delta.content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        if (!this.toolCalls[i]) {
          this.toolCalls[i] = {
            id: tc.id || "",
            type: tc.type || "function",
            function: { name: "", arguments: "" },
          };
        }
        const slot = this.toolCalls[i];
        if (tc.id) slot.id = tc.id;
        if (tc.type) slot.type = tc.type;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
    return added;
  }

  get cleanToolCalls() {
    return this.toolCalls.filter(Boolean);
  }

  toMessage() {
    const msg = { role: "assistant", content: this.content || "" };
    const calls = this.cleanToolCalls;
    if (calls.length) {
      msg.tool_calls = calls.map((c, i) => ({
        id: c.id || `call_${Date.now()}_${i}`,
        type: c.type || "function",
        function: { name: c.function.name, arguments: c.function.arguments || "{}" },
      }));
    }
    return msg;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
