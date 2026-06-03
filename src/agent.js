// Non-interactive agent driver: runs one user→assistant exchange end-to-end,
// streaming the model, executing tool calls inline, and emitting structured
// events so the Telegram front-end can render live progress/animations.
//
// Works with any OpenAI-compatible model. Primary path uses native tool_calls;
// a conservative text fallback also runs tool calls that a model emits as a
// fenced ```tool_call {json}``` block, so even models with weaker function
// calling can still drive the toolchain.

import { ChatRequest } from "./types.js";
import { APIError, DeltaAccumulator } from "./api.js";
import { pruneMessages } from "./store.js";

// onEvent(kind, payload) kinds:
//   "thinking"            (model call starting)
//   "text_delta"  {text}
//   "tool_start"  {name, arguments, call_id}
//   "tool_end"    {name, call_id, output}
//   "iteration"   {index}
//   "done"        {text}
//   "error"       {error}

export async function runTurn({
  client,
  registry,
  ctx,
  cfg,
  session,
  systemPrompt,
  userContent, // string OR array (for vision: [{type:text..},{type:image_url..}])
  onEvent = () => {},
}) {
  const emit = (kind, payload) => {
    try {
      onEvent(kind, payload);
    } catch {
      /* front-end errors must not break the loop */
    }
  };

  if (userContent != null) {
    session.messages.push({ role: "user", content: userContent });
  }

  const tools = registry.schemas();
  const finalParts = [];
  // Auto-recovery bookkeeping: count how often each identical tool call fails so
  // we can nudge the model toward a different approach instead of looping.
  const callFails = new Map(); // signature -> consecutive failure count
  const callSeen = new Map(); // signature -> total times attempted

  for (let iteration = 0; iteration < cfg.maxToolIters; iteration++) {
    emit("iteration", { index: iteration });
    emit("thinking", {});

    const pruned = pruneMessages(session.messages, {
      charBudget: cfg.contextCharBudget,
      toolResultCharCap: cfg.toolResultCharCap,
    });
    const messages = [{ role: "system", content: systemPrompt }, ...pruned];

    const req = new ChatRequest({
      model: session.model || cfg.defaultModel,
      messages,
      tools,
      maxTokens: cfg.maxTokens || undefined,
    });

    const accum = new DeltaAccumulator();
    try {
      await client.stream(req, (delta) => {
        const added = accum.push(delta);
        if (added) emit("text_delta", { text: added });
      });
    } catch (e) {
      if (e instanceof APIError && e.status >= 400 && e.status < 500) {
        // Some endpoints reject streaming or tools; try a non-streaming call once.
        try {
          const resp = await client.chat(req);
          const msg = resp?.choices?.[0]?.message;
          if (msg) {
            accum.content = msg.content || "";
            if (Array.isArray(msg.tool_calls)) accum.toolCalls = msg.tool_calls;
          }
        } catch (e2) {
          emit("error", { error: String(e2.message || e2) });
          return finalParts.join("");
        }
      } else {
        emit("error", { error: String(e.message || e) });
        return finalParts.join("");
      }
    }

    const assistantMsg = accum.toMessage();
    let toolCalls = assistantMsg.tool_calls || [];

    // Text fallback: parse ```tool_call {json}``` blocks if no native calls.
    if (!toolCalls.length && assistantMsg.content) {
      const parsed = parseTextToolCalls(assistantMsg.content);
      if (parsed.length) {
        toolCalls = parsed.map((c, i) => ({
          id: `txt_${Date.now()}_${i}`,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
        }));
        assistantMsg.tool_calls = toolCalls;
      }
    }

    session.messages.push(assistantMsg);
    if (assistantMsg.content) finalParts.push(assistantMsg.content);

    if (!toolCalls.length) {
      const text = finalParts.join("");
      emit("done", { text });
      return text;
    }

    for (const tc of toolCalls) {
      const name = tc.function?.name || "";
      const rawArgs = tc.function?.arguments || "{}";
      const callId = tc.id || `call_${Date.now()}`;
      const sig = `${name}:${rawArgs}`;
      const seen = (callSeen.get(sig) || 0) + 1;
      callSeen.set(sig, seen);

      emit("tool_start", { name, arguments: rawArgs, call_id: callId });

      // Loop breaker: if the model keeps issuing the exact same call, stop
      // running it and tell it to change approach (prevents wasteful loops).
      let output;
      if (seen > 4) {
        output = JSON.stringify({
          error: `Loop guard: '${name}' was called with identical arguments ${seen} times. ` +
            `Stop repeating it — change the arguments, try a different tool/approach, or if you are truly stuck, ` +
            `explain the blocker to the user.`,
          _loop_guard: true,
        });
      } else {
        output = await registry.invoke(name, rawArgs, ctx);
      }

      // Detect failure and append a recovery hint so the model self-corrects.
      const failed = outputIsError(output);
      if (failed) {
        const fails = (callFails.get(sig) || 0) + 1;
        callFails.set(sig, fails);
        if (fails >= 2) {
          emit("recover", { name, attempts: fails });
          output = withRecoveryHint(output, fails);
        }
      } else {
        callFails.delete(sig);
      }

      emit("tool_end", { name, call_id: callId, output });
      session.messages.push({
        role: "tool",
        tool_call_id: callId,
        name,
        content: output,
      });
    }
    // loop again, feeding tool results back to the model.
  }

  const text = finalParts.join("") || "(reached the tool-iteration limit)";
  emit("done", { text });
  return text;
}

// Does a tool's JSON output represent a failure? We only treat an explicit
// `error` field as a failure (a non-zero exit_code can be legitimate, e.g. grep
// with no matches), to avoid false positives.
function outputIsError(output) {
  if (typeof output !== "string") return false;
  try {
    const obj = JSON.parse(output);
    return !!(obj && typeof obj === "object" && obj.error);
  } catch {
    return false;
  }
}

// Append a recovery hint to a failed tool result so the model changes tack
// instead of repeating the same failing call.
function withRecoveryHint(output, attempts) {
  const hint =
    attempts >= 3
      ? "This approach has failed multiple times. Try a clearly DIFFERENT strategy " +
        "(different tool, inspect the inputs first, or fix the root cause). If genuinely blocked, tell the user what's wrong."
      : "That call failed. Read the error, then adjust your arguments or try a different approach — do not repeat the same call.";
  try {
    const obj = JSON.parse(output);
    if (obj && typeof obj === "object") {
      obj._recovery_hint = hint;
      obj._attempts = attempts;
      return JSON.stringify(obj);
    }
  } catch {
    /* fall through */
  }
  return `${output}\n_recovery_hint: ${hint}`;
}

// Very conservative parser for models that print tool calls as text.
function parseTextToolCalls(content) {
  const calls = [];
  const re = /```(?:tool_call|json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(content))) {
    const body = m[1].trim();
    if (!body.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(body);
    } catch {
      continue;
    }
    const name = obj.tool || obj.name || obj.function;
    const args = obj.arguments || obj.args || obj.parameters || {};
    if (typeof name === "string" && name) calls.push({ name, arguments: args });
  }
  return calls;
}
