import "../helpers/firefox.mjs";
import { checker, crash } from "../helpers/common.mjs";
import { fakeAcp } from "../helpers/fake-acp.mjs";
import { AcpSession, acpPermission, acpCallKey, toAcpBlocks } from "../../src/acp.mjs";
const { check, done } = checker();
const pause = () => new Promise((r) => setTimeout(r, 10));

(async () => {
  check("slash commands are sent as literal text even with leading whitespace", toAcpBlocks("  /schedule now")[0].text.startsWith("User message (literal text):"));
  const blocks = toAcpBlocks([{ type: "text", text: "Look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "BBBB" } }]);
  check("images and PDFs preserve bytes and MIME types", blocks[1].data === "AAAA" && blocks[2].resource.blob === "BBBB" && blocks[2].resource.mimeType === "application/pdf");
  let unsupported = false; try { toAcpBlocks([{ type: "video" }]); } catch (e) { unsupported = true; }
  check("unsupported attachments fail visibly", unsupported);
  check("permission names map to panel descriptors", acpPermission({ name: "run_command", rawInput: { CommandLine: "echo hi", toolSummary: "ignore" } }).input.command === "echo hi" && acpPermission({ name: "read_file", rawInput: { Path: "/tmp/a" } }).tool_name === "Read");
  check("unknown built-ins and web search cannot be approved", acpPermission({ name: "search_web" }) === null && acpPermission({ name: "new_unsafe_tool" }) === null);
  check("call keys ignore object ordering, not values", acpCallKey("x", { a: 1, b: 2 }) === acpCallKey("x", { b: 2, a: 1 }) && acpCallKey("x", { a: 1 }) !== acpCallKey("x", { a: 2 }));

  const fake = fakeAcp({ holdReplies: true });
  const text = [], results = [], errors = [], tools = [], permissions = [];
  let allow, sessionGone = false;
  const handlers = {
    onText: (s) => text.push(s), onStatus() {}, onInit() {}, onDone: (m) => results.push(m), onError: (s) => errors.push(s), onSessionGone: () => { sessionGone = true; },
    onPermission: async (p) => { permissions.push(p); return allow ? await allow(p) : { behavior: "allow", updatedInput: p.input }; },
    onMcpMessage: async (server, m) => { tools.push(m); return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } }; },
  };
  const session = new AcpSession(handlers, fake);
  session.setModel("claude-test"); session.setEffort("high");
  let sending = session.send("Hello");
  while (!fake.sent.length) await pause();
  check("initialization advertises no filesystem/terminal access", fake.calls[0].params.clientCapabilities.terminal === false && fake.calls[0].params.clientCapabilities.fs.readTextFile === false);
  check("session receives only Zen's MCP server and appended system prompt", fake.calls.find((m) => m.method === "session/new").params.mcpServers.length === 1 && fake.calls.find((m) => m.method === "session/new").params._meta.antigravity.systemPrompt.append.includes("untrusted_content"));
  check("model and effort are applied before the prompt", fake.procs[0].config[0].currentValue === "claude-test" && fake.procs[0].config[1].currentValue === "high");
  check("MCP call without ACP permission is refused", (await fake.callTool("save_file", { name: "a.txt", content: "x" })).result.isError && tools.length === 0);
  const args = { ref: "e1", then_click: "e2" };
  allow = async (p) => ({ behavior: "allow", updatedInput: { ref: p.input.ref } });
  check("MCP permission strips injected summaries", (await fake.permission("mcp_zenai_browser_fill_form", { ...args, toolSummary: "summary" })).outcome.optionId === "allow" && !permissions.at(-1).input.toolSummary);
  check("different arguments cannot consume a grant", (await fake.callTool("browser_fill_form", { ref: "e9" })).result.isError);
  await fake.callTool("browser_fill_form", args);
  check("sanitized approval arguments are applied at the bridge", tools.at(-1).params.arguments.ref === "e1" && !tools.at(-1).params.arguments.then_click);
  check("a grant is consumed exactly once", (await fake.callTool("browser_fill_form", args)).result.isError);
  session.setTainted(true);
  const before = permissions.length;
  check("tainted sessions reject built-ins before asking the panel", (await fake.permission("run_command", { CommandLine: "echo no" })).outcome.optionId === "deny" && permissions.length === before);
  session.setTainted(false);
  check("allow_always is never substituted for allow_once", (await fake.permission("read_file", { Path: "/tmp/x" }, { options: [{ optionId: "forever", kind: "allow_always" }] })).outcome.outcome === "cancelled");
  let release;
  allow = () => new Promise((r) => { release = r; });
  const pending = fake.permission("read_file", { Path: "/tmp/x" });
  while (!release) await pause();
  session.stop();
  check("Stop cancels a pending approval immediately", (await pending).outcome.outcome === "cancelled");
  release({ behavior: "allow" });
  await sending;
  check("stopped turns don't report completion or errors", !results.length && !errors.length && !session.busy);
  check("MCP calls after Stop are refused", (await fake.callTool("save_file", { name: "a", content: "b" })).result.isError);
  allow = null;
  sending = session.send("Next");
  while (fake.sent.length < 2) await pause();
  fake.finishReplies(); await sending;
  check("next turn streams normally in the same process", fake.procs.length === 1 && text.join("") === "Reply from Antigravity" && results[0].contextTokens === 12345);
  const sid = session.sessionId;
  await session.kill();
  check("kill closes the bridge", fake.bridges[0].closed);
  sending = session.send("Resume");
  while (fake.sent.length < 3) await pause();
  check("resume uses the same provider session ID", fake.calls.some((m) => m.method === "session/resume" && m.params.sessionId === sid));
  fake.finishReplies(); await sending;
  await session.kill();
  session.sessionId = "missing";
  try { await session.send("Gone"); } catch (e) {}
  check("missing sessions notify the panel and clean up", sessionGone && !session.proc && fake.bridges.at(-1).closed);

  const delayed = fakeAcp(); let ready;
  delayed.prepare = () => new Promise((r) => { ready = r; });
  const starting = new AcpSession(handlers, delayed);
  const wait = starting.send("Don't send");
  starting.stop();
  ready({ command: "/fake/agy", arguments: ["acp"] });
  await wait;
  check("Stop during startup doesn't send the queued prompt", delayed.sent.length === 0);
  await starting.kill();
  done();
})().catch(crash);
