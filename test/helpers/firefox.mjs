// Node stand-ins for the Firefox chrome APIs the modules touch, so the real
// session/tool code can run outside the browser. Import this BEFORE any src/
// module (session.mjs fetches Subprocess when it loads).
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, claudeBin, testHome } from "./common.mjs";

// Real processes behind Firefox's Subprocess API
export const Subprocess = {
  calls: [],
  async call({ command, arguments: args, workdir, environment }) {
    Subprocess.calls.push({ command, args, environment });
    const p = spawn(command, args, { cwd: workdir, env: { ...process.env, ...(environment || {}), HOME: testHome(), PATH: process.env.PATH } });
    const queue = (stream) => {
      const chunks = [];
      let waiter = null, ended = false;
      stream.on("data", (d) => { chunks.push(d.toString()); if (waiter) { waiter(); waiter = null; } });
      stream.on("end", () => { ended = true; if (waiter) { waiter(); waiter = null; } });
      return { async readString() { while (!chunks.length && !ended) await new Promise((r) => (waiter = r)); return chunks.length ? chunks.splice(0).join("") : ""; } };
    };
    return {
      stdout: queue(p.stdout),
      stderr: queue(p.stderr),
      stdin: { write: (s) => new Promise((r) => p.stdin.write(s, r)) },
      wait: () => new Promise((r) => p.on("exit", (c) => r({ exitCode: c }))),
      kill: async () => p.kill(),
    };
  },
};

// Files the mod writes (Claude Output, skills) go under test/.home
export const FAKE_HOME = join(ROOT, "test", ".home");
mkdirSync(FAKE_HOME, { recursive: true });
const prefStore = new Map([["zenai.claudePath", claudeBin()]]);

globalThis.ChromeUtils = { importESModule: (url) => (url.includes("Subprocess") ? { Subprocess } : {}) };
globalThis.Services = {
  prefs: {
    getStringPref: (n, f) => (prefStore.has(n) ? prefStore.get(n) : f),
    setStringPref: (n, v) => prefStore.set(n, String(v)),
    addObserver() {},
    removeObserver() {},
  },
  dirsvc: { get: () => ({ path: FAKE_HOME }) },
};
globalThis.Ci = { nsIFile: {} };
globalThis.IOUtils = {
  makeDirectory: async (d) => mkdirSync(d, { recursive: true }),
  exists: async (p) => existsSync(p),
  write: async (p, b) => writeFileSync(p, b),
  writeUTF8: async (p, t) => writeFileSync(p, t),
  read: async (p) => new Uint8Array(readFileSync(p)),
  readUTF8: async (p) => readFileSync(p, "utf8"),
};
globalThis.PathUtils = { join: (...a) => join(...a), filename: (p) => p.split("/").pop(), profileDir: FAKE_HOME };
export const prefs = prefStore;
