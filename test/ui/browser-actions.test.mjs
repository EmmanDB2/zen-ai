// Browser actions end to end, offline: the built mod (dist/) in a jsdom Zen
// window, a fake Claude Code asking for and calling browser tools, and the
// real page agent running (as a frame script) against a jsdom web page.
// Covers fill_form's then_click (fill and click Next in one step) and the
// waits after an action (they end once the page has gone quiet).
import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const FILL = "mcp__zenai__browser_fill_form";
const PAGE = `<!doctype html><html><body>
<h1>Application, step <span id="step">1</span> of 3</h1>
<form id="f">
  <label>Full name <input id="name"></label>
  <label>Email <input id="email" type="email"></label>
  <label>Password <input id="pw" type="password"></label>
  <button type="button" id="help">Help</button>
  <button type="button" id="next">Next</button>
  <button type="submit" id="send">Submit application</button>
</form></body></html>`;

const KANBAN = `<!doctype html><html><body>
<section class="board">
  <div class="column"><h3>To do</h3><div class="cards"><div class="card" draggable="true" id="c1">Write essay</div></div></div>
  <div class="column"><h3>Done</h3><div class="cards" id="done"></div></div>
  <div class="trash" aria-label="Trash" ondragover="return false">Trash</div>
</section></body></html>`;

(async () => {
  const zen = await fakeZen({ holdReplies: true, page: PAGE });
  const { $, $$, click } = zen;
  const web = zen.webPage();
  let nexts = 0;
  // Next re-renders the page a little later, the way SPAs do
  web.document.getElementById("next").addEventListener("click", () => {
    nexts++;
    setTimeout(() => { web.document.getElementById("step").textContent = String(nexts + 1); }, 60);
  });
  let submits = 0;
  web.document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); submits++; });
  const card = () => $(".zai-approval");
  const rows = () => $$(".zai-approval .zai-fields span").map((x) => x.textContent);

  await zen.open();
  await zen.send("Fill in the application for me", { wait: false });
  await sleep(80);
  // Refs come from reading the page, as Claude would
  const read = await zen.askPermission("mcp__zenai__browser_read", {});
  const snap = (await zen.callTool("browser_read", read.updatedInput)).content.map((c) => c.text).join("");
  const refOf = (re) => (snap.split("\n").find((l) => re.test(l)) || "").match(/\[(e\d+)\]/)?.[1];
  const R = { name: refOf(/"Full name"/), email: refOf(/"Email"/), next: refOf(/button "Next"/), send: refOf(/"Submit application"/), pw: refOf(/"Password"/), help: refOf(/button "Help"/) };
  check("reading the page gives refs (no card for reading)", read.behavior === "allow" && Object.values(R).every(Boolean), { R, snap: snap.slice(0, 300) });

  // --- Fill two fields, then click Next: one card, one call ---
  let answer = zen.askPermission(FILL, { fields: [{ ref: R.name, value: "Alex Kim" }, { ref: R.email, value: "alex@example.com" }], then_click: R.next });
  await sleep(80);
  check("one card for filling and clicking Next", card() && /Fill 2 fields, then click “Next”/.test(card().textContent), card() && card().textContent.slice(0, 80));
  check("the card lists the values and the button", rows().join("|") === "Full name|Alex Kim|Email|alex@example.com|Then click|“Next”", rows());
  check("Next doesn't submit, so no warning and the site can be allowed", !$(".zai-approval-warn") && !!$(".zai-allow-site"));
  click($(".zai-allow"));
  let r = await answer;
  check("allowed, with then_click passed along", r.behavior === "allow" && r.updatedInput.then_click === R.next, r);
  let t0 = Date.now();
  let res = await zen.callTool("browser_fill_form", r.updatedInput);
  const took = Date.now() - t0;
  const text = res.content.map((c) => c.text).join("");
  check("both fields filled, then Next clicked", web.document.getElementById("name").value === "Alex Kim" && web.document.getElementById("email").value === "alex@example.com" && nexts === 1);
  check("the result says so (and doesn't claim nothing was submitted)", /Filled 2 of 2 fields, then clicked “Next”/.test(text) && !/Nothing was submitted/.test(text), text.slice(0, 120));
  check("the page agent ran as frame scripts", zen.frameScripts.length >= 4, zen.frameScripts.length);
  check("the wait after it ended once the page was quiet, after its late re-render", web.document.getElementById("step").textContent === "2" && took < 900, { took, step: web.document.getElementById("step").textContent });

  // --- A submit button as then_click: always asks, with the warning ---
  answer = zen.askPermission(FILL, { fields: [{ ref: R.name, value: "Alex" }], then_click: R.send });
  await sleep(80);
  check("then_click on a submit button: the warning, no 'allow on this site'", !!$(".zai-approval-warn") && /Submit application/.test($(".zai-approval-warn").textContent) && !$(".zai-allow-site"));
  click($(".zai-deny"));
  r = await answer;
  check("...and Deny denies the whole thing", r.behavior === "deny" && submits === 0);

  // --- A protected field: filled by the user, so the button waits too ---
  answer = zen.askPermission(FILL, { fields: [{ ref: R.name, value: "Alex" }, { ref: R.pw, value: "hunter2" }], then_click: R.next });
  await sleep(80);
  check("protected field: skipped, and the card says Next waits for you", rows().some((x) => /Skipped: password/.test(x)) && rows().some((x) => /Not yet: “Next” waits/.test(x)), rows());
  click($(".zai-allow"));
  r = await answer;
  check("...the password and the click are taken out of the call", r.behavior === "allow" && r.updatedInput.fields.length === 1 && !("then_click" in r.updatedInput), r.updatedInput);
  res = await zen.callTool("browser_fill_form", r.updatedInput);
  check("...so Next isn't clicked", nexts === 1 && web.document.getElementById("pw").value === "", nexts);

  // --- Something that can't be filled (a button): Next isn't clicked ---
  answer = zen.askPermission(FILL, { fields: [{ ref: R.name, value: "Alex" }, { ref: R.help, value: "x" }], then_click: R.next });
  await sleep(80);
  click($(".zai-allow"));
  r = await answer;
  res = await zen.callTool("browser_fill_form", r.updatedInput);
  const held = res.content.map((c) => c.text).join("");
  check("a field failed: Next isn't clicked, and the result says why", nexts === 1 && held.includes(`Didn't click ${R.next}: not every field was filled`), held.slice(0, 160));

  // --- then_click must be a button or link ---
  r = await zen.askPermission(FILL, { fields: [{ ref: R.name, value: "Alex" }], then_click: R.email });
  check("then_click on a text field is refused", r.behavior === "deny" && /button or link/.test(r.message), r);

  // --- Allowed on this site: the next fill + Next goes straight through ---
  answer = zen.askPermission(FILL, { fields: [{ ref: R.email, value: "m@example.com" }], then_click: R.next });
  await sleep(80);
  click($(".zai-allow-site"));
  await answer;
  r = await zen.askPermission(FILL, { fields: [{ ref: R.name, value: "Alex Kim" }], then_click: R.next });
  check("allowed site: no card, and the line in the chat says what happened", r.behavior === "allow" && !card() &&
    $$(".zai-thread .zai-toolline").some((l) => /Fill 1 field, then click “Next” · allowed on this site/.test(l.textContent)));

  check("no errors", zen.errors.length === 0, zen.errors);
  await zen.finishReplies();
  await zen.close();

  // --- Drag and drop (browser_drag) on a kanban board ---
  const board = await fakeZen({ holdReplies: true, page: KANBAN });
  const page2 = board.webPage();
  let dragged = null; // jsdom has no DataTransfer: the page keeps the card itself
  page2.document.querySelectorAll(".card").forEach((c) => c.addEventListener("dragstart", () => (dragged = c)));
  page2.document.querySelectorAll(".cards").forEach((list) => {
    list.addEventListener("dragover", (e) => e.preventDefault());
    list.addEventListener("drop", (e) => { e.preventDefault(); if (dragged) list.append(dragged); });
  });
  await board.open();
  await board.send("Move my essay to Done", { wait: false });
  await sleep(80);
  const read2 = await board.askPermission("mcp__zenai__browser_read", {});
  const snap2 = (await board.callTool("browser_read", read2.updatedInput)).content.map((c) => c.text).join("");
  const ref2 = (re) => (snap2.split("\n").find((l) => re.test(l)) || "").match(/\[(e\d+)\]/)?.[1];
  const B = { essay: ref2(/draggable "Write essay"/), done: ref2(/drop area "Done"/), trash: ref2(/drop area "Trash"/) };
  check("drag: the read lists the card and the drop areas", B.essay && B.done && B.trash, snap2);
  const DRAG = "mcp__zenai__browser_drag";
  answer = board.askPermission(DRAG, { from: B.essay, to: B.done });
  await sleep(80);
  const dcard = board.$(".zai-approval");
  check("drag: one card saying what goes where", dcard && /Drag “Write essay” onto “Done”/.test(dcard.textContent) && !!board.$(".zai-allow-site") && !board.$(".zai-approval-warn"), dcard && dcard.textContent.slice(0, 80));
  board.click(board.$(".zai-allow"));
  r = await answer;
  res = await board.callTool("browser_drag", r.updatedInput);
  const dtext = res.content.map((c) => c.text).join("");
  check("drag: the card moves, and the result says so", r.behavior === "allow" && page2.document.querySelector("#done .card") && /Dragged “Write essay” onto “Done”/.test(dtext), dtext.slice(0, 120));
  answer = board.askPermission(DRAG, { from: B.essay, to: B.trash });
  await sleep(80);
  check("drag: onto Trash gets the warning, and can't be allowed for the site", /might delete or remove it/.test((board.$(".zai-approval-warn") || {}).textContent || "") && !board.$(".zai-allow-site"));
  board.click(board.$(".zai-deny"));
  r = await answer;
  check("drag: Deny denies", r.behavior === "deny" && !!page2.document.querySelector("#done .card"));
  r = await board.askPermission(DRAG, { from: B.essay, by: { x: 0, y: 0 } });
  check("drag: no target and no offset is refused", r.behavior === "deny" && /Say where/.test(r.message), r);
  answer = board.askPermission(DRAG, { from: B.essay, to: B.done, position: "before" });
  await sleep(80);
  board.click(board.$(".zai-allow-site"));
  await answer;
  r = await board.askPermission(DRAG, { from: B.essay, by: { x: 120, y: -40 } });
  check("drag: allowed site goes straight through, with a line in the chat", r.behavior === "allow" && !board.$(".zai-approval") &&
    board.$$(".zai-thread .zai-toolline").some((l) => /Drag “Write essay” by 120 px right, 40 px up · allowed on this site/.test(l.textContent)));
  check("drag: no errors", board.errors.length === 0, board.errors);
  await board.finishReplies();
  await board.close();
  done();
})().catch(crash);
