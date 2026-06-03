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

// Guess whether an arbitrary model id is vision-capable from its name.
export function guessVision(id) {
  return VISION_HINTS.some((h) => String(id).toLowerCase().includes(h));
}

// Merge a base catalogue with user-added custom models. Custom entries are
// added to (and override label/vision of) the base list, and always appear
// even when the provider's /models endpoint doesn't list them. Returns a fresh
// array of {id, label, vision, custom?}.
export function mergeModels(base, custom) {
  const out = [];
  const byId = new Map();
  for (const m of base || []) {
    const entry = { ...m };
    out.push(entry);
    byId.set(entry.id, entry);
  }
  for (const c of custom || []) {
    if (!c || !c.id) continue;
    const existing = byId.get(c.id);
    if (existing) {
      if (c.label) existing.label = c.label;
      if (c.vision !== undefined) existing.vision = !!c.vision;
      existing.custom = true;
    } else {
      const entry = {
        id: c.id,
        label: c.label || labelFor(c.id),
        vision: c.vision !== undefined ? !!c.vision : guessVision(c.id),
        custom: true,
      };
      out.push(entry);
      byId.set(entry.id, entry);
    }
  }
  return out;
}

export async function fetchModels(cfg) {
  const custom = Array.isArray(cfg?.customModels) ? cfg.customModels : [];
  let base = FALLBACK_MODELS.slice();
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
        vision: typeof m.vision === "boolean" ? m.vision : guessVision(m.id),
      }));
    if (models.length) base = models;
  } catch {
    // Offline / no key / custom endpoint without /models — keep the fallback.
    base = FALLBACK_MODELS.slice();
  }
  return mergeModels(base, custom);
}

export function isVisionModel(modelId, models) {
  const m = (models || FALLBACK_MODELS).find((x) => x.id === modelId);
  if (m) return !!m.vision;
  return VISION_HINTS.some((h) => String(modelId).toLowerCase().includes(h));
}
