// Model discovery. The API is OpenAI-compatible, so we try GET /models to list
// what the provider currently offers. If that fails (offline, no key, custom
// endpoint without /models), we fall back to the known catalogue.

// Fallback catalogue, used only when GET /models fails. Kept in sync with what
// the provider actually serves (bare ids, exactly as /models returns them) so
// the menu never offers a model that 403s with "not available". `vision: true`
// means the model accepts images, used when forwarding Telegram photos.
export const FALLBACK_MODELS = [
  { id: "qwen3.7-max", label: "Qwen 3.7 Max" },
  { id: "qwen3.7-plus", label: "Qwen 3.7 Plus" },
  { id: "minimax-m3", label: "MiniMax M3" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "qwen3.6-plus", label: "Qwen 3.6 Plus (Vision)", vision: true },
  { id: "glm-5.1", label: "GLM 5.1" },
  { id: "qwen3.5-plus", label: "Qwen 3.5 Plus" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "kimi-k2.5", label: "Kimi K2.5" },
  { id: "gpt-5.5", label: "GPT 5.5" },
];

const VISION_HINTS = ["vision", "-vl", "3.6-plus", "qwen3.6", "gpt-4o", "claude", "gemini"];

function labelFor(id) {
  const known = FALLBACK_MODELS.find((m) => m.id === id);
  if (known) return known.label;
  // Prettify: strip prefix, title-case-ish.
  const base = id.includes("/") ? id.split("/").pop() : id;
  return base
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export async function fetchModels(cfg) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(`${cfg.apiBaseUrl}/models`, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const models = list
      .map((m) => (typeof m === "string" ? { id: m } : m))
      .filter((m) => m && m.id)
      .map((m) => ({
        id: m.id,
        label: labelFor(m.id),
        // Prefer the provider's own vision flag; fall back to name heuristics.
        vision:
          typeof m.vision === "boolean"
            ? m.vision
            : VISION_HINTS.some((h) => String(m.id).toLowerCase().includes(h)),
      }));
    if (models.length) return models;
    throw new Error("empty model list");
  } catch {
    return FALLBACK_MODELS.slice();
  }
}

export function isVisionModel(modelId, models) {
  const m = (models || FALLBACK_MODELS).find((x) => x.id === modelId);
  if (m) return !!m.vision;
  return VISION_HINTS.some((h) => String(modelId).toLowerCase().includes(h));
}
