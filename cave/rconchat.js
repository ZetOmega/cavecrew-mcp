// cave/rconchat.js — minimal raw-TCP RCON client for chat-lookalike lines.
//
// No deps: implements the Source RCON protocol directly (packet format per
// https://developer.valvesoftware.com/wiki/Source_RCON_Protocol). Modeled on
// swarm/rcon.mjs (which wraps the rcon-client npm package) but reimplemented
// on raw net.Socket so this file adds nothing to package.json.
//
// Usage:
//   import { createRconChat } from './rconchat.js';
//   const chat = createRconChat(); // reads cave/local.json
//   await chat.sayStatus('Miner1', 'yellow', 'idle, no task');
//   await chat.close();

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_COMMAND = 2;
const TYPE_RESPONSE = 0; // eslint-disable-line no-unused-vars -- documents the protocol constant

function loadRconConfig(cfg) {
  if (cfg?.rcon) return cfg.rcon;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'local.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.rcon) return parsed.rcon;
  } catch {
    // no local.json (or unreadable) — fall through to defaults
  }
  return { host: '127.0.0.1', port: 25575, password: '' };
}

function encodePacket(id, type, payload) {
  const body = Buffer.from(payload, 'utf8');
  const size = 4 + 4 + body.length + 2; // id + type + payload + 2 null terminators
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  body.copy(buf, 12);
  buf.writeInt8(0, 12 + body.length);
  buf.writeInt8(0, 12 + body.length + 1);
  return buf;
}

export function createRconChat(cfg) {
  const { host, port, password } = loadRconConfig(cfg);
  let socket = null;
  let authed = false;
  let connecting = null;
  let nextId = 1;
  let recvBuf = Buffer.alloc(0);
  const pending = new Map(); // reqId (number) or 'auth' -> {resolve, reject}
  let chain = Promise.resolve();

  function failAllPending(err) {
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  }

  function onData(chunk) {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    while (recvBuf.length >= 4) {
      const size = recvBuf.readInt32LE(0);
      if (recvBuf.length < 4 + size) break;
      const packet = recvBuf.subarray(4, 4 + size);
      recvBuf = recvBuf.subarray(4 + size);
      const id = packet.readInt32LE(0);
      const type = packet.readInt32LE(4);
      const payload = packet.subarray(8, packet.length - 2).toString('utf8');
      if (type === TYPE_AUTH_RESPONSE) {
        const waiter = pending.get('auth');
        pending.delete('auth');
        if (id === -1) waiter?.reject(new Error('rcon auth failed (bad password)'));
        else {
          authed = true;
          waiter?.resolve();
        }
        continue;
      }
      const waiter = pending.get(id);
      if (waiter) {
        pending.delete(id);
        waiter.resolve(payload);
      }
    }
  }

  function connect() {
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port }, () => {
        socket = s;
        const authId = nextId++;
        pending.set('auth', { resolve, reject });
        s.write(encodePacket(authId, TYPE_AUTH, password));
      });
      s.on('data', onData);
      s.on('error', (err) => reject(err));
      s.on('close', () => {
        socket = null;
        authed = false;
        connecting = null;
        failAllPending(new Error('rcon connection closed'));
      });
    });
    connecting.catch(() => {
      socket = null;
      authed = false;
      connecting = null;
    });
    return connecting;
  }

  async function ensureConnected() {
    if (socket && authed) return;
    await connect();
  }

  function sendRaw(command) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.write(encodePacket(id, TYPE_COMMAND, command));
    });
  }

  function send(command) {
    const result = chain.then(async () => {
      await ensureConnected();
      try {
        return await sendRaw(command);
      } catch {
        // one retry after forcing a fresh reconnect
        socket = null;
        authed = false;
        connecting = null;
        await ensureConnected();
        return await sendRaw(command);
      }
    });
    chain = result.catch(() => {}); // keep the queue alive past a failed command
    return result;
  }

  function tellraw(payload) {
    return send(`tellraw @a ${JSON.stringify(payload)}`);
  }

  // Whole line subtle grey — teamColor kept in the signature for parity with
  // sayFancy/future use, but not applied to any segment here on purpose.
  function sayStatus(botName, teamColor, text) {
    return tellraw([
      { text: '<', color: 'dark_gray' },
      { text: `[CAVE] ${botName}`, color: 'dark_gray' },
      { text: '> ', color: 'dark_gray' },
      { text: String(text), color: 'gray' },
    ]);
  }

  function sayFancy(botName, teamColor, text, color = 'gold') {
    return tellraw([
      { text: '<', color: 'dark_gray' },
      { text: `[CAVE] ${botName}`, color: teamColor },
      { text: '> ', color: 'dark_gray' },
      { text: String(text), color },
    ]);
  }

  function close() {
    failAllPending(new Error('rcon closed'));
    return new Promise((resolve) => {
      if (!socket) return resolve();
      socket.end(() => resolve());
    });
  }

  return { send, sayStatus, sayFancy, close };
}
