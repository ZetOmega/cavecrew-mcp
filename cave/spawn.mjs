#!/usr/bin/env node
// cave/spawn.mjs — fleet spawner CLI for cavecrew bots.
//
// Usage:
//   node cave/spawn.mjs start <Name> <port>
//   node cave/spawn.mjs stop <Name>
//   node cave/spawn.mjs list
//
// start  spawns a detached `node cave/runner.js --name <Name> --port <port>`
//        process, stdout/stderr redirected to cave/logs/<Name>.log, and
//        writes cave/pids/<Name>.json. Refuses if the bot already has a
//        live pid file, or if the requested port is already in use.
// stop   best-effort POSTs /stop to the bot's HTTP API, then kills the
//        process tree (taskkill /T /F on Windows), then removes the pid
//        file.
// list   reads cave/pids/*.json and prints a table with liveness checked
//        against the OS.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CAVE_DIR = __dirname;
const REPO_ROOT = path.dirname(CAVE_DIR);
const PIDS_DIR = path.join(CAVE_DIR, 'pids');
const LOGS_DIR = path.join(CAVE_DIR, 'logs');
const RUNNER_PATH = path.join(CAVE_DIR, 'runner.js');

function ensureDirs() {
  fs.mkdirSync(PIDS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function pidFilePath(name) {
  return path.join(PIDS_DIR, `${name}.json`);
}

function readPidFile(name) {
  const p = pidFilePath(name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

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

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

async function killTree(pid) {
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      k.on('exit', resolve);
      k.on('error', resolve);
    });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

async function postStop(port) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    await fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST', signal: ctrl.signal });
    clearTimeout(timer);
    return true;
  } catch {
    return false; // best-effort only
  }
}

async function cmdStart(name, portArg) {
  if (!name || !portArg) {
    console.error('usage: node cave/spawn.mjs start <Name> <port>');
    process.exitCode = 1;
    return;
  }
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`refuse: invalid port ${portArg}`);
    process.exitCode = 1;
    return;
  }

  ensureDirs();

  const existing = readPidFile(name);
  if (existing && isAlive(existing.pid)) {
    console.error(`refuse: ${name} already running (pid ${existing.pid}, port ${existing.port})`);
    process.exitCode = 1;
    return;
  }

  const free = await isPortFree(port);
  if (!free) {
    console.error(`refuse: port ${port} already in use`);
    process.exitCode = 1;
    return;
  }

  const logPath = path.join(LOGS_DIR, `${name}.log`);
  const fd = fs.openSync(logPath, 'a');

  let child;
  try {
    child = spawn(process.execPath, [RUNNER_PATH, '--name', name, '--port', String(port)], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }

  child.unref();

  const record = {
    pid: child.pid,
    port,
    name,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(pidFilePath(name), JSON.stringify(record, null, 2));

  console.log(`started ${name} pid=${child.pid} port=${port}`);
}

async function cmdStop(name) {
  if (!name) {
    console.error('usage: node cave/spawn.mjs stop <Name>');
    process.exitCode = 1;
    return;
  }
  const rec = readPidFile(name);
  if (!rec) {
    console.error(`no pid file for ${name} — nothing to stop`);
    process.exitCode = 1;
    return;
  }

  await postStop(rec.port);
  await killTree(rec.pid);

  try {
    fs.unlinkSync(pidFilePath(name));
  } catch {
    // already gone
  }

  console.log(`stopped ${name} (pid ${rec.pid}, port ${rec.port})`);
}

async function cmdList() {
  ensureDirs();
  const files = fs.readdirSync(PIDS_DIR).filter((f) => f.endsWith('.json'));

  if (files.length === 0) {
    console.log('no bots registered');
    return;
  }

  const rows = files.map((f) => {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(PIDS_DIR, f), 'utf8'));
      return { ...rec, alive: isAlive(rec.pid) };
    } catch {
      return { name: f.replace(/\.json$/, ''), pid: '?', port: '?', startedAt: '?', alive: false };
    }
  });

  const nameW = Math.max(4, ...rows.map((r) => String(r.name).length));
  const pidW = Math.max(3, ...rows.map((r) => String(r.pid).length));
  const portW = Math.max(4, ...rows.map((r) => String(r.port).length));

  console.log(`${'NAME'.padEnd(nameW)}  ${'PID'.padEnd(pidW)}  ${'PORT'.padEnd(portW)}  STATUS  STARTED`);
  for (const r of rows) {
    const status = r.alive ? 'alive ' : 'dead  ';
    console.log(
      `${String(r.name).padEnd(nameW)}  ${String(r.pid).padEnd(pidW)}  ${String(r.port).padEnd(portW)}  ${status}  ${r.startedAt}`
    );
  }
}

async function main() {
  const [, , cmd, a, b] = process.argv;

  switch (cmd) {
    case 'start':
      await cmdStart(a, b);
      break;
    case 'stop':
      await cmdStop(a);
      break;
    case 'list':
      await cmdList();
      break;
    default:
      console.error('usage: node cave/spawn.mjs start <Name> <port> | stop <Name> | list');
      process.exitCode = 1;
  }
}

main();
