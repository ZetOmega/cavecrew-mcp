// cave/webinv.js — best-effort mineflayer-web-inventory starter.
//
// GLUE: wired into runner.js's b.once('spawn', ...) handler (see wireBot())
// — call tryStartWebInventory(bot, httpPort) once the bot exists. `httpPort`
// is the runner's own HTTP API port (e.g. 3201); web-inventory binds on
// httpPort + WEB_INVENTORY_PORT_OFFSET (e.g. 4201). No other wiring needed.
//
// RECONCILE NOTE: this file originally shipped as CommonJS (require/
// module.exports), but package.json has "type":"module" and runner.js is
// ESM — a plain require() call from runner.js would throw immediately
// ("require is not defined"), and module.exports here would too ("module is
// not defined") since Node parses every .js file in this package as ESM.
// Rewritten to import/export; mineflayer-web-inventory itself is still a
// plain CJS default export (`module.exports = function(bot, options){...}`),
// which is loaded here via dynamic import() instead of require().

const WEB_INVENTORY_PORT_OFFSET = 1000;

/**
 * Best-effort start of mineflayer-web-inventory for a bot. Never throws —
 * if the plugin is missing, broken, or the port is taken, this logs and
 * resolves false so the runner keeps working without it. Safe to call once
 * per bot instance (e.g. on every 'spawn', across reconnects) — each call
 * targets the same fixed port for a given runner, so a reconnect racing the
 * previous bot's web-inventory server teardown just logs a skip here rather
 * than throwing.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {number} httpPort - this runner's own HTTP API port (e.g. 3201)
 * @returns {Promise<boolean>} true if web-inventory started, false if skipped
 */
async function tryStartWebInventory(bot, httpPort) {
  const port = httpPort + WEB_INVENTORY_PORT_OFFSET;
  try {
    const mod = await import('mineflayer-web-inventory');
    const inventoryViewer = mod.default ?? mod;
    inventoryViewer(bot, { port });
    console.log(`[webinv] started on port ${port} (base ${httpPort})`);
    return true;
  } catch (err) {
    console.log(`[webinv] skipped (port ${port}): ${err && err.message ? err.message : err}`);
    return false;
  }
}

export { tryStartWebInventory, WEB_INVENTORY_PORT_OFFSET };
