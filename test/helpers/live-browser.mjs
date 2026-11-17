// Real Claude Code + the mod's real session and tool code, acting in a
// Playwright page. The browser tools here mirror runBrowserTool in
// src/panel.mjs (same result texts, same "only what changed" page reads), and
// the permission policy acts like a careful user: allow everything except
// submitting, and never pass protected fields along.
import "./firefox.mjs";
import { pageAgentRunner } from "./common.mjs";
import { ClaudeSession } from "../../src/session.mjs";
import { handleZenMcp } from "../../src/files.mjs";
import { describePage } from "../../src/browser-agent.mjs";
import { WAIT_MAX_SECONDS, WAIT_POLL_MS } from "../../src/config.mjs";

const DENIED = "The user denied this. Don't retry it; ask the user what they'd like to do instead.";

export async function runBrowserTask(page, ask, { effort = "medium", trace = !!process.env.TRACE, timeoutMs = 300000 } = {}) {
  const agent = await pageAgentRunner(page);
  const calls = {};
  const waits = []; // browser_wait calls: { max, args, seconds }
  let toolChars = 0;
  let seen = null;
  const text = (t) => { toolChars += t.length; return [{ type: "text", text: t }]; };
  const must = (r) => { if (r && r.error) throw new Error(r.error); return r; };
  const look = async (full = false) => {
    const s = must(await agent({ action: "snapshot" }));
    const d = describePage(full ? null : seen, s);
    seen = d.state;
    return d.text;
  };
  // Like settle() in src/browser-agent.mjs: until the page is quiet (clicks
  // wait at least as long as before; typing and filling don't)
  const after = async (what, typing = false) => {
    await page.waitForTimeout(100);
    await agent({ action: "settle", minMs: typing ? 0 : 350, quietMs: 150, maxMs: 1500 });
    return text(`${what}\n\nThe page now:\n${await look()}`);
  };
  // Points from a screenshot (like the panel): the latest screenshot's
  // geometry, dropped by any other action; a point action takes a new one
  let shot = null;
  const screenshot = async () => {
    const v = must(await agent({ action: "viewport" }));
    const b = await page.screenshot({ type: "jpeg", quality: 80 });
    shot = { ratio: 1, sx: v.sx, sy: v.sy, doc: v.doc, w: v.w, h: v.h };
    return { type: "image", data: b.toString("base64"), mimeType: "image/jpeg" };
  };
  const needShot = () => { if (!shot) throw new Error("Take a browser_screenshot first: points are read off your latest screenshot of this tab, and any action since it may have changed the page."); return shot; };
  const afterPoint = async (what) => {
    const out = await after(what);
    out.push(await screenshot(), { type: "text", text: `The visible page now, ${shot.w}×${shot.h} px (untrusted page content). Later points refer to this screenshot.` });
    return out;
  };
  const xy = (p) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
  // Where the time goes: Claude Code starting, Claude's turns, our actions
  const timeline = [];
  const mark = (what) => timeline.push([what, Date.now()]);
  const browserTool = async (name, a) => {
    mark("tool " + name);
    calls[name] = (calls[name] || 0) + 1;
    const pointShot = shot;
    if (name !== "browser_read" && name !== "browser_screenshot") shot = null;
    const usePoints = () => { shot = pointShot; return needShot(); };
    let out;
    switch (name) {
      case "browser_read": out = text(await look(!!a.full)); break;
      case "browser_fill_form": {
        const r = must(await agent({ action: "fill", fields: a.fields }));
        const lines = r.results.map((x) => `- ${x.ref}${x.label ? ` “${x.label}”` : ""}: ${x.status}${x.note ? ` (${x.note})` : ""}`);
        const filled = r.results.filter((x) => x.status === "filled").length;
        if (a.then_click && filled === r.results.length && filled) {
          calls.then_click = (calls.then_click || 0) + 1;
          const c = must(await agent({ action: "click", ref: a.then_click }));
          out = await after(`Filled ${filled} of ${r.results.length} fields, then clicked “${c.label}”.${c.note ? " " + c.note : ""}\n${lines.join("\n")}\n`);
        } else {
          const held = a.then_click ? `\nDidn't click ${a.then_click}: not every field was filled.` : "";
          out = await after(`Filled ${filled} of ${r.results.length} fields. Nothing was submitted.${held}\n${lines.join("\n")}\n`, true);
        }
        break;
      }
      case "browser_type": { const r = must(await agent({ action: "type", ref: a.ref, text: String(a.text ?? ""), append: !!a.append })); out = await after(`Typed into “${r.label}”.${r.note ? " " + r.note : ""}`, true); break; }
      case "browser_click": {
        if (!a.ref && a.point) {
          calls.points = (calls.points || 0) + 1;
          const r = must(await agent({ action: "click", at: a.point, shot: usePoints() }));
          out = await afterPoint(`Clicked ${r.label ? `“${r.label}”` : r.what} at ${xy(a.point)} in your screenshot.${r.note ? " " + r.note : ""}`);
          break;
        }
        const r = must(await agent({ action: "click", ref: a.ref }));
        out = await after(`Clicked “${r.label}”.${r.note ? " " + r.note : ""}`);
        break;
      }
      case "browser_drag": {
        const fromAt = !a.from ? a.from_point || null : null;
        const toAt = !a.to ? a.to_point || null : null;
        if (fromAt || toAt) calls.points = (calls.points || 0) + 1;
        const r = must(await agent({ action: "drag", from: a.from || null, to: a.to || null, fromAt, toAt, shot: fromAt || toAt ? usePoints() : null, position: a.position || "onto", by: a.by || null }));
        const what = fromAt ? `${r.label ? `“${r.label}”` : r.what} from ${xy(fromAt)}` : `“${r.label}”`;
        const where = toAt ? ` to ${xy(toAt)}${r.to ? `, on “${r.to}”` : ""}` : r.to ? ` ${a.position === "before" || a.position === "after" ? a.position : "onto"} “${r.to}”` : ` by ${JSON.stringify(a.by)}`;
        const text = `Dragged ${what}${where}.${r.note ? " " + r.note : ""}`;
        out = fromAt || toAt ? await afterPoint(text) : await after(text);
        break;
      }
      case "browser_select": { const r = must(await agent({ action: "select", ref: a.ref, option: a.option })); out = await after(`Chose “${r.chosen}” in “${r.label}”.`); break; }
      case "browser_press_key": { const r = must(await agent({ action: "key", key: a.key, ref: a.ref })); out = await after(`Pressed ${a.key} in ${r.target === "the page" ? "the page" : `“${r.target}”`}.`); break; }
      case "browser_scroll": { const r = must(await agent({ action: "scroll", direction: a.direction, ref: a.ref })); await agent({ action: "settle", quietMs: 150, maxMs: 1500 }); out = text(`Scrolled; now ${r.percent}% down the page.\n\n${await look()}`); break; }
      case "browser_wait": {
        // Like browserWait in src/panel.mjs (no chat line here)
        const max = Math.max(1, Math.min(WAIT_MAX_SECONDS, Math.round(Number(a.seconds) || 0)));
        const want = { text: a.until_text || "", gone: a.until_text_gone || "", ref: a.until_changed || "", video: !!a.until_video_ends };
        const check = () => agent({ action: "watch", text: want.text, gone: want.gone, ref: want.ref });
        const first = must(await check());
        const met = (r) => (want.text && r.text ? `“${want.text}” is on the page` : want.gone && r.gone ? `“${want.gone}” is gone from the page`
          : want.ref && r.ref !== first.ref ? `${want.ref} changed` : want.video && r.video && r.video.ended ? "the video ended" : "");
        const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
        const vid = (v) => (!v ? "" : v.ended ? ` Right now the video has ended (${clock(v.duration)}).` : ` Right now the video is at ${clock(v.time)}${v.duration ? ` of ${clock(v.duration)}` : ""}, ${v.paused ? "paused" : "playing"}.`);
        if (met(first)) { out = text(`No need to wait: ${met(first)} already.${vid(first.video)}`); break; }
        const t0 = Date.now();
        waits.push({ max, args: a });
        let outcome = "";
        let last = first;
        while (!outcome) {
          await page.waitForTimeout(Math.min(WAIT_POLL_MS, Math.max(0, t0 + max * 1000 - Date.now())));
          last = await check();
          outcome = met(last) || (Date.now() - t0 >= max * 1000 - 50 ? "time's up" : "");
        }
        waits[waits.length - 1].seconds = Math.round((Date.now() - t0) / 1000);
        const took = clock((Date.now() - t0) / 1000);
        out = await after(outcome === "time's up" ? `Waited the full ${took}.${vid(last.video)} Call browser_wait again to keep waiting.` : `After ${took}: ${outcome}.${vid(last.video)}`, true);
        break;
      }
      case "browser_screenshot": {
        out = [await screenshot(), { type: "text", text: `The visible part of ${page.url()}, ${shot.w}×${shot.h} px (untrusted page content). For something without a ref, browser_click and browser_drag take points in this image's pixels.` }];
        break;
      }
      default: throw new Error("not supported in this test: " + name);
    }
    if (trace) console.log("  tool", name, JSON.stringify(a).slice(0, 140), "→", out.map((o) => (o.text ? o.text.length + " chars" : "image")).join(" + "));
    mark("done " + name);
    return out;
  };

  const t0 = Date.now();
  mark("send");
  let finish;
  const finished = new Promise((r) => (finish = r));
  let firstText = true;
  const session = new ClaudeSession({
    onText() { if (firstText) { firstText = false; mark("text"); } }, onAssistantMessage() {}, onStatus() {},
    onInit() { mark("Claude Code ready"); },
    onDone: (msg) => finish(msg),
    onError: (e) => finish({ is_error: true, result: String(e) }),
    async onPermission(req) {
      const name = req.tool_name.replace("mcp__zenai__", "");
      let input = req.input;
      if (name === "browser_click" && !input.ref && input.point) {
        if (!shot) return { behavior: "deny", message: "Take a browser_screenshot first: points are read off your latest screenshot of this tab, and any action since it may have changed the page." };
        const sp = (await agent({ action: "describe", refs: [], points: [input.point], shot })).spots[0] || {};
        if (!sp.found) return { behavior: "deny", message: sp.error || "Nothing there." };
        if (sp.submits && /submit|send|pay|buy|place order/i.test(`${sp.label} ${sp.submits}`)) return { behavior: "deny", message: DENIED };
      } else if (name === "browser_drag" && ((!input.from && input.from_point) || (!input.to && input.to_point)) && !shot) {
        return { behavior: "deny", message: "Take a browser_screenshot first: points are read off your latest screenshot of this tab, and any action since it may have changed the page." };
      } else if (name === "browser_click" || name === "browser_press_key") {
        const d = input.ref ? (await agent({ action: "describe", refs: [input.ref] })).items[0] : {};
        if ((d && d.submits && /submit|send|pay|buy|place order/i.test(`${d.label} ${d.submits}`)) || input.key === "Enter") return { behavior: "deny", message: DENIED };
      }
      if (name === "browser_type" || name === "browser_fill_form") {
        const refs = name === "browser_type" ? [input.ref] : input.fields.map((f) => f.ref);
        const items = (await agent({ action: "describe", refs })).items;
        if (name === "browser_type" && items[0].protected) return { behavior: "deny", message: "That's a protected field." };
        if (name === "browser_fill_form") input = { ...input, fields: input.fields.filter((f, i) => !items[i].protected) };
        // then_click: the same careful user, who won't let it submit
        if (name === "browser_fill_form" && input.then_click) {
          const b = (await agent({ action: "describe", refs: [input.then_click] })).items[0] || {};
          if (b.submits && /submit|send|pay|buy|place order/i.test(`${b.label} ${b.submits}`)) return { behavior: "deny", message: DENIED };
          if (input.fields.length < items.length) delete input.then_click;
        }
      }
      return { behavior: "allow", updatedInput: input };
    },
    onMcpMessage: (s, msg) => handleZenMcp(msg, { onFile: () => {}, browserTool }),
  });
  session.effort = effort;
  session.tainted = true; // a chat with web content: no shell/file tools
  const timer = setTimeout(() => finish({ is_error: true, result: "timed out" }), timeoutMs);
  session.send(ask);
  const result = await finished;
  mark("result");
  clearTimeout(timer);
  // Seconds in our tools vs everything else (Claude Code and Claude's turns)
  let inTools = 0;
  for (let i = 0; i < timeline.length; i++) if (timeline[i][0].startsWith("tool ")) inTools += (timeline.find((m, j) => j > i && m[0].startsWith("done ")) || [0, timeline[i][1]])[1] - timeline[i][1];
  const ready = timeline.find((m) => m[0] === "Claude Code ready");
  const steps = timeline.map(([w, t]) => `${((t - t0) / 1000).toFixed(1)}s ${w}`);
  await session.reset();
  const u = result.usage || {};
  return {
    result,
    calls,
    toolChars,
    requests: result.num_turns,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    tokens: { input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens, cacheTtl: u.cache_creation || null },
    waits,
    cost: result.total_cost_usd,
    timing: { startup: ready ? Math.round((ready[1] - t0) / 100) / 10 : null, inTools: Math.round(inTools / 100) / 10, steps },
  };
}
