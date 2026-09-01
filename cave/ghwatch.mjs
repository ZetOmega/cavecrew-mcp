#!/usr/bin/env node
// cave/ghwatch.mjs — GitHub issues watchdog for the cavecrew fleet.
//
// Polls two repos every 120s via `gh api` (gh CLI must already be
// authenticated on this machine), diffs each issue's updated_at against a
// persisted last-seen map, and fires an alert (alerts.log line + Discord
// webhook) for every issue that is new or has changed since last seen.
//
// First run (no state file yet) captures a silent baseline — every issue is
// recorded but nothing is alerted, so startup never floods the log/Discord
// with the entire existing issue history.
//
// No npm deps: node:child_process (execFile of gh), node:fs, node:https only.
//
// Run: node cave/ghwatch.mjs   (detached; pid in cave/ghwatch.pid)

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, 'ghwatch-state.json');
const PID_FILE = path.join(HERE, 'ghwatch.pid');
const ALERTS_LOG = path.join(HERE, 'alerts.log');
const LOCAL_JSON = path.join(HERE, 'local.json');

const POLL_MS = 120_000;
const DISCORD_TIMEOUT_MS = 3000;

const REPOS = [
  { full: 'ZetOmega/cavecrew-mcp', short: 'ours' },
  { full: 'felsenuboot/felcrew-mcp', short: 'felcrew' },
];

// ---------------------------------------------------------------------------
// single-instance guard — plain-text pidfile, checked with a signal-0 probe.
// ---------------------------------------------------------------------------
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it -> still alive.
    return err && err.code === 'EPERM';
  }
}

function guardSingleInstance() {
  if (fs.existsSync(PID_FILE)) {
    const prevPid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (isAlive(prevPid)) {
      console.error(`ghwatch: already running (pid ${prevPid}) — exiting`);
      process.exit(1);
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function releasePid() {
  try {
    const owner = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (owner === process.pid) fs.unlinkSync(PID_FILE);
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// state persistence — { "<repoFull>": { "<issueNumber>": "<updated_at>" } }
// ---------------------------------------------------------------------------
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    console.error(`ghwatch: failed to parse state file, starting fresh — ${err.message}`);
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// local.json — BOM-strip, discord webhook lookup. Missing key = skip silently.
// ---------------------------------------------------------------------------
function getWebhookUrl() {
  if (!fs.existsSync(LOCAL_JSON)) return null;
  try {
    let raw = fs.readFileSync(LOCAL_JSON, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
    const cfg = JSON.parse(raw);
    const url = cfg?.discord?.orchestratorWebhookUrl;
    return typeof url === 'string' && url.trim() ? url : null;
  } catch (err) {
    console.error(`ghwatch: failed to parse local.json — ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// gh CLI — execFile with an argv array, never a shell string.
// ---------------------------------------------------------------------------
function ghListIssues(repoFull) {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['api', `repos/${repoFull}/issues?state=all&sort=updated&direction=desc&per_page=15`],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.error(`ghwatch: gh api failed for ${repoFull} — ${err.message}`);
          return resolve(null);
        }
        try {
          const parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed)) throw new Error('response was not an array');
          resolve(parsed);
        } catch (parseErr) {
          console.error(`ghwatch: non-JSON response for ${repoFull} — ${parseErr.message}`);
          resolve(null);
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// discord — best-effort, never throws, always resolves.
// ---------------------------------------------------------------------------
function postDiscord(webhookUrl, content) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(webhookUrl);
    } catch {
      return resolve(false);
    }

    const payload = JSON.stringify({ username: 'GhWatch', content });
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
        timeout: DISCORD_TIMEOUT_MS,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));

    req.write(payload);
    req.end();
  });
}

function appendAlertLog(line) {
  try {
    fs.appendFileSync(ALERTS_LOG, line + '\n');
  } catch (err) {
    console.error(`ghwatch: failed to write alerts.log — ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// one poll cycle
// ---------------------------------------------------------------------------
async function pollOnce(state, firstRun) {
  const webhookUrl = getWebhookUrl();

  for (const { full, short } of REPOS) {
    const issues = await ghListIssues(full);
    if (!issues) continue; // gh failed or returned non-JSON — skip, retry next cycle

    if (!state[full]) state[full] = {};
    const seen = state[full];

    for (const issue of issues) {
      const number = issue.number;
      const updatedAt = issue.updated_at;
      if (seen[number] === updatedAt) continue; // unchanged since last seen

      seen[number] = updatedAt; // always record, even on first run

      if (firstRun) continue; // baseline capture only — no alerts on first run

      const title = issue.title;
      const login = issue.user?.login ?? 'unknown';
      const kind = issue.pull_request ? '[PR]' : '[ISSUE]';
      const ts = new Date().toISOString();
      const logLine = `[${ts}] [ghwatch] ${kind} ${short}#${number} updated: "${title}" (by ${login})`;
      appendAlertLog(logLine);
      console.log(logLine);

      if (webhookUrl) {
        const content = `🔔 ${kind} ${short}#${number} updated: ${title} (by ${login}) — https://github.com/${full}/issues/${number}`;
        postDiscord(webhookUrl, content);
      }
    }
  }

  saveState(state);
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------
async function main() {
  guardSingleInstance();
  process.on('SIGINT', () => { releasePid(); process.exit(0); });
  process.on('SIGTERM', () => { releasePid(); process.exit(0); });

  const firstRun = !fs.existsSync(STATE_FILE);
  const state = loadState();

  console.log(`ghwatch: starting — pid ${process.pid}, poll every ${POLL_MS / 1000}s, firstRun=${firstRun}`);

  await pollOnce(state, firstRun);

  setInterval(() => {
    pollOnce(state, false).catch((err) => {
      console.error(`ghwatch: poll cycle error — ${err.message}`);
    });
  }, POLL_MS);
}

main().catch((err) => {
  console.error(`ghwatch: fatal — ${err.message}`);
  releasePid();
  process.exit(1);
});
