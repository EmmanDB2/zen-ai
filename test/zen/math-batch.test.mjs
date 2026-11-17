// Fewer steps for math answers, in real Zen (what math-heavy skills rely
// on): a math box below the view is typed into with no click or scroll first
// (typing brings it into view and confirms the cursor is in it), and one
// browser_fill_form fills several math boxes, key by key, in one step.
import { checker, crash } from "../helpers/common.mjs";
import { realZen, textOf, zenMissing } from "../helpers/real-zen.mjs";

const { check, done } = checker();
const refIn = (text, re) => ((text.split("\n").find((l) => re.test(l)) || "").match(/\[((?:f\d+\.)?e\d+)\]/) || [])[1];

(async () => {
  if (zenMissing()) {
    console.log(`SKIP  real Zen isn't available: ${zenMissing()}`);
    done();
  }
  const zen = await realZen({ holdReplies: true });
  try {
    await zen.open();
    await zen.openTab(zen.page("math-noapi.html"));
    // Push both boxes well below the view
    await zen.inPage((win) => { const d = win.document; const s = d.createElement("div"); s.style.height = "2600px"; d.body.insertBefore(s, d.querySelector("label")); win.scrollTo(0, 0); return true; });
    await zen.send("Answer the questions", { wait: false });
    let text = textOf(await zen.tool("browser_read", { full: true }));
    const first = refIn(text, /math box "Answer"/);
    const second = refIn(text, /math box "Second answer"/);
    check("both math boxes are listed (keys, no API)", !!first && !!second && /input=keys/.test(text), text.slice(-600));

    let allowed = false;
    const act = async (name, args) => {
      const perm = zen.askPermission("mcp__zenai__" + name, args);
      if (!allowed) { await zen.approve("all"); allowed = true; }
      const p = await perm;
      return zen.callTool(name, p.updatedInput);
    };

    // One box, below the view, no click or scroll first
    const before = await zen.inPage((win) => win.scrollY);
    let res = await act("browser_type", { ref: first, text: "3x^2{Right}/4" });
    let page = await zen.inPage((win) => ({ answers: win.wrappedJSObject.readAnswers(), y: win.scrollY, find: !!win.document.querySelector(".findbar-textbox:focus") }));
    check("typing into a box below the view works with no click or scroll first", before === 0 && page.y > 1000 && /3x\^2/.test(page.answers[0]) && /4/.test(page.answers[0]), { page, res: textOf(res).slice(0, 200) });

    // Both boxes in one fill
    await zen.inPage((win) => { win.scrollTo(0, 0); return true; });
    res = await act("browser_fill_form", { fields: [{ ref: first, value: "x+1" }, { ref: second, value: "2/3" }] });
    page = await zen.inPage((win) => win.wrappedJSObject.readAnswers());
    check("one browser_fill_form fills two math boxes", page[0] === "x+1" && /\\frac\{2\}\{3\}/.test(page[1]), { page, res: textOf(res).slice(0, 300) });
    check("...and reports each as filled", /Filled 2 of 2 fields/.test(textOf(res)), textOf(res).slice(0, 200));
    // A cheap check of one box: its close-up
    const close = await zen.tool("browser_screenshot", { ref: second });
    const m = textOf(close).match(/(\d+)×(\d+) px/);
    check("a close-up of a math box is a small image", m && Number(m[1]) * Number(m[2]) < 200000, textOf(close).slice(0, 120));
    check("no errors from the mod", zen.errors().length === 0, zen.errors());
    await zen.finishReplies();
  } finally {
    await zen.quit();
  }
  done();
})().catch(crash);
