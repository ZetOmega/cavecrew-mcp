// cave/discord.mjs — plain https POST to a Discord webhook, used to route
// routine 'status' narration out of game chat and into a Discord channel
// (user decree: status chatter -> Discord, game chat = real talk only).
//
// No deps: uses node:https directly. Every call is best-effort — a bad
// webhook, a network hiccup, or a slow Discord response never throws back
// into the caller; postStatus() always resolves, returning false on any
// failure (including the 2s timeout) and true on a 2xx response.
//
// Usage:
//   import { postStatus, isConfigured } from './discord.mjs';
//   if (isConfigured(localCfg)) {
//     await postStatus({ botName, color, text, webhookUrl: localCfg.discord.webhookUrl });
//   }

import https from 'node:https';

const POST_TIMEOUT_MS = 2000;

// isConfigured(cfg) — cfg is the parsed cave/local.json object (or undefined).
// True only when cfg.discord.webhookUrl is a non-empty string that isn't the
// example placeholder.
export function isConfigured(cfg) {
  const url = cfg?.discord?.webhookUrl;
  return typeof url === 'string' && url.trim().length > 0 && url !== 'CHANGE_ME';
}

// postStatus({ botName, color, text, webhookUrl }) — fires a Discord webhook
// message with username "[CAVE] <botName>" and the given text as content.
// `color` is accepted for a consistent call signature with the rcon
// announce() paths but Discord webhooks have no per-message text color, so it
// is currently unused here (kept in the signature so callers don't need to
// branch). Always resolves; never rejects. Returns false silently on any
// failure: bad URL, network error, non-2xx response, or timeout.
export function postStatus({ botName, color, text, webhookUrl }) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(webhookUrl);
    } catch {
      return resolve(false);
    }

    const payload = JSON.stringify({
      username: `[CAVE] ${botName}`,
      content: String(text),
    });

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: POST_TIMEOUT_MS,
      },
      (res) => {
        // Drain the response body so the socket can close cleanly; we don't
        // care about the body content, only the status code.
        res.on('data', () => {});
        res.on('end', () => {
          resolve(res.statusCode >= 200 && res.statusCode < 300);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => {
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}
