// cave/drives-llm.js — DeepSeek client wrapper (LEAD ANNOTATION F, v2 chief
// ruling 2026-09-01: no Anthropic key — DeepSeek API). Uses the `openai`
// npm package (DeepSeek is OpenAI-compatible), baseURL
// "https://api.deepseek.com". Key resolution (cave/local.json's
// deepseek.apiKey, gitignored, or env DEEPSEEK_API_KEY), startup
// model-list fetch + match-or-dormant, decisionCall()/reflectionCall().
// Every exported call returns a result object and NEVER throws — the whole
// point of this wrapper is that a network blip, an auth failure, or a
// missing key degrades the engine to dormant/retry-next-tick, never a
// crash and never a retry storm.

import OpenAI from 'openai';

const BASE_URL = 'https://api.deepseek.com';

let client = null;
let clientKeyUsed = null;

function getClient(apiKey) {
  // Rebuild only if the key actually changed (e.g. local.json edited and a
  // caller re-resolves) — cheap either way, but avoids constructing a fresh
  // SDK client on every single call.
  if (!client || clientKeyUsed !== apiKey) {
    client = new OpenAI({ apiKey, baseURL: BASE_URL });
    clientKeyUsed = apiKey;
  }
  return client;
}

// resolveApiKey(localConfig) — localConfig is the caller's own already-
// loaded cave/local.json object (runner.js caches this itself; this module
// stays pure-network and never touches the filesystem). Env var is checked
// only when local.json has nothing usable configured. The example file's
// placeholder value ("CHANGE_ME") is treated the same as absent — never an
// attempted real key.
export function resolveApiKey(localConfig) {
  const fromFile = localConfig?.deepseek?.apiKey;
  if (typeof fromFile === 'string' && fromFile && fromFile !== 'CHANGE_ME') return fromFile;
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
  return null;
}

// verifyModel(apiKey, modelName) — GETs the provider's model list once and
// checks the configured name is present. Never throws: a network/auth
// failure during verification comes back as {ok:false, available:[]} —
// same dormant outcome as a plain name mismatch, since either way
// annotation F's rule is "never guess-spend on a wrong/unverified model".
export async function verifyModel(apiKey, modelName) {
  try {
    const c = getClient(apiKey);
    const list = await c.models.list();
    const ids = (list?.data ?? []).map((m) => m.id);
    return { ok: ids.includes(modelName), available: ids };
  } catch (err) {
    return { ok: false, available: [], error: err?.message ?? String(err) };
  }
}

async function chatCall(apiKey, model, systemPrompt, userContent) {
  try {
    const c = getClient(apiKey);
    const resp = await c.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: typeof userContent === 'string' ? userContent : JSON.stringify(userContent) },
      ],
      temperature: 0.4,
    });
    const text = resp?.choices?.[0]?.message?.content ?? '';
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function decisionCall(apiKey, model, promptText, stateSnapshot) {
  return chatCall(apiKey, model, promptText, stateSnapshot);
}

export async function reflectionCall(apiKey, model, promptText, inputSummary) {
  return chatCall(apiKey, model, promptText, inputSummary);
}
