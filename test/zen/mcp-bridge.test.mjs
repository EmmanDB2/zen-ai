import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { checker, crash, src } from "../helpers/common.mjs";
import { realZen, zenMissing, sleep } from "../helpers/real-zen.mjs";

const { check, done } = checker();
if (zenMissing()) { console.log("SKIP " + zenMissing()); process.exit(0); }

(async () => {
  const zen = await realZen();
  let nc;
  try {
    writeFileSync(join(zen.profile, "chrome/JS/cmd/bridge.js"), readFileSync(src("mcp-bridge.mjs"), "utf8").replace(/^export /gm, "") + "\nwindow.bridgeFactory = createMcpBridge;\n");
    const path = await zen.chrome(async () => {
      Services.scriptloader.loadSubScript("chrome://userscripts/content/cmd/bridge.js", window);
      window.bridgeCalls = [];
      window.bridge = await window.bridgeFactory(async (message) => {
        window.bridgeCalls.push(message.method);
        const result = message.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "zenai", version: "test" } }
          : message.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: message.params.arguments.text }] };
        return { jsonrpc: "2.0", id: message.id, result };
      });
      return window.bridge.path;
    });
    check("private folder and socket have 0700 / 0600 permissions", (statSync(dirname(path)).mode & 0o777) === 0o700 && (statSync(path).mode & 0o777) === 0o600);
    nc = spawn("/usr/bin/nc", ["-U", path]);
    nc.stdout.setEncoding("utf8");
    let buffer = "";
    const replies = [], pending = new Map();
    nc.stdout.on("data", (d) => {
      buffer += d.toString();
      let n;
      while ((n = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
        replies.push(message);
        if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      }
    });
    let id = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => reject(new Error("MCP response timed out")), 10000);
      pending.set(key, (r) => { clearTimeout(timer); resolve(r); });
      nc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n");
    });
    check("nc initialize round trip", (await rpc("initialize", {})).result.serverInfo.name === "zenai");
    check("nc tools/list round trip", (await rpc("tools/list", {})).result.tools[0].name === "echo");
    const text = "Unicode: café 🦊 中文\n".repeat(20000);
    check("large UTF-8 tool results survive stream boundaries and backpressure", (await rpc("tools/call", { name: "echo", arguments: { text } })).result.content[0].text === text);
    check("ping and server/discover answer locally", !!(await rpc("ping", {})).result && !!(await rpc("server/discover", {})).result && (await zen.chrome(() => window.bridgeCalls)).length === 3);
    nc.stdin.write('{broken\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await sleep(100);
    check("invalid JSON returns a parse error; notifications get no response", replies.at(-1).error.code === -32700 && replies.length === 6);
    nc.stdin.write('[]\n');
    await sleep(100);
    check("invalid request shapes return an error", replies.at(-1).error.code === -32600);
    const second = spawn("/usr/bin/nc", ["-U", path]);
    const secondClosed = await Promise.race([new Promise((r) => second.on("exit", () => r(true))), sleep(1000).then(() => false)]);
    second.kill();
    check("a second connection is rejected", secondClosed);
    await zen.chrome(() => window.bridge.close());
    check("close removes socket and its folder", !existsSync(path) && !existsSync(dirname(path)));
    await zen.chrome(() => window.bridge.close());
    check("closing twice is safe", zen.errors().length === 0, zen.errors());
    nc.kill();
    const hugePath = await zen.chrome(async () => {
      window.bridgeFailure = "";
      window.bridge = await window.bridgeFactory(() => { throw new Error("Should not execute"); }, { onClosed: (e) => { window.bridgeFailure = e.message; } });
      return window.bridge.path;
    });
    nc = spawn("/usr/bin/nc", ["-U", hugePath]);
    nc.stdin.on("error", () => {});
    nc.stdin.write("x".repeat(16 * 1024 * 1024 + 1));
    await zen.until(() => zen.chrome(() => !!window.bridgeFailure), 15000, "oversized request rejection");
    check("oversized messages close the connection and remove the socket", /too large/.test(await zen.chrome(() => window.bridgeFailure)) && !existsSync(hugePath));
    nc.kill();
    const disconnectPath = await zen.chrome(async () => {
      window.bridgeFailure = "";
      window.bridge = await window.bridgeFactory(() => null, { onClosed: (e) => { window.bridgeFailure = e.message; } });
      return window.bridge.path;
    });
    nc = spawn("/usr/bin/nc", ["-U", disconnectPath]);
    await sleep(100);
    nc.kill();
    await zen.until(() => zen.chrome(() => !!window.bridgeFailure), 5000, "disconnect cleanup");
    check("client disconnect reports failure and removes its private folder", !existsSync(dirname(disconnectPath)));
  } finally { if (nc) nc.kill(); await zen.quit(); }
  done();
})().catch(crash);
