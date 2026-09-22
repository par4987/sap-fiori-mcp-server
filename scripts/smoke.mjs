#!/usr/bin/env node
/**
 * Starts the built server over stdio with production dependencies only and walks
 * one real MCP handshake. Vitest needs Node >= 22.12, so the unit suite cannot
 * say anything about the Node 20 floor in package.json#engines; this can.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, LOG_LEVEL: "off" }
});

let stderr = "";
child.stderr.on("data", (b) => (stderr += b.toString()));

const pending = new Map();
let buffer = "";
child.stdout.on("data", (b) => {
  buffer += b.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`the server wrote something that is not JSON-RPC on stdout: ${line.slice(0, 200)}`);
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function fail(why) {
  console.error(`smoke: ${why}`);
  if (stderr.trim()) console.error(`--- server stderr ---\n${stderr.trim()}`);
  child.kill();
  process.exit(1);
}

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const wait = new Promise((resolve) => pending.set(id, resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return Promise.race([
    wait,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} did not answer within 30s`)), 30_000))
  ]);
}

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" }
  });
  if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`);
  if (!init.result?.serverInfo?.name) fail("initialize answered without a serverInfo.name");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const listed = await send("tools/list", {});
  if (listed.error) fail(`tools/list failed: ${JSON.stringify(listed.error)}`);
  const tools = listed.result?.tools ?? [];
  if (tools.length === 0) fail("tools/list returned no tools");
  for (const t of tools) {
    if (t.inputSchema?.type !== "object") fail(`tool ${t.name} has no object inputSchema`);
  }

  // A tool that touches neither the network nor a live SAP system.
  const called = await send("tools/call", { name: tools.find((t) => t.name.endsWith("search_docs"))?.name ?? tools[0].name, arguments: { query: "odata" } });
  if (called.error) fail(`tools/call failed: ${JSON.stringify(called.error)}`);

  console.log(`smoke: ${init.result.serverInfo.name} ${init.result.serverInfo.version} on node ${process.version}, ${tools.length} tools`);
  child.kill();
  await once(child, "exit");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
