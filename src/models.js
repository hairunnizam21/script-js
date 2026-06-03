// Model discovery. The API is OpenAI-compatible, so we try GET /models to list
// what the provider currently offers. If that fails (offline, no key, custom
// endpoint without /models), we fall back to the known catalogue.

// Fallback catalogue (the models the provider advertised). `vision: true`
// means the model accepts images, used when forwarding Telegram photos.
export const FALLBACK_MODELS = [
  { id: "fiq/qwen3.7-max", label: "Qwen 3.7 Max" },
  { id: "fiq/qwen3.7-plus", label: "Qwen 3.7 Plus" },
  { id: "fiq/minimax-m2.7", label: "MiniMax M2.7" },
  { id: "fiq/minimax-m3", label: "MiniMax M3" },
  { id: "fiq/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "fiq/qwen3.6-plus", label: "Qwen 3.6 Plus (Vision)", vision: true },
  { id: "fiq/glm-5.1", label: "GLM 5.1" },
  { id: "fiq/qwen3.5-plus", label: "Qwen 3.5 Plus" },
  { id: "fiq/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "fiq/kimi-k2.5", label: "Kimi K2.5" },
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
      .map((m) => (typeof m === "string" ? m : m.id))
      .filter(Boolean)
      .map((id) => ({
        id,
        label: labelFor(id),
        vision: VISION_HINTS.some((h) => id.toLowerCase().includes(h)),
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
