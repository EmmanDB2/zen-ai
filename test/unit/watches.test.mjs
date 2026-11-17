// Watches without DOM: the condition from the tool's arguments, how often,
// whether a check meets it, what the list says, what's saved.
import { checker, crash } from "../helpers/common.mjs";
import { WATCH_LIMITS, checkNote, cleanWatches, conditionMet, describeCondition, everyText, isDue, newWatch, watchCondition, watchEvery, watchWakeText } from "../../src/watches.mjs";

const { check, done } = checker();

(async () => {
  const until = watchCondition({ until_button: "  Add   to cart ", until_text_gone: "Sold out", until_text: "" });
  check("the condition: given parts only, tidied", JSON.stringify(until) === '{"gone":"Sold out","button":"Add to cart"}', until);
  check("...and none given is refused", /Say what to watch for/.test((() => { try { watchCondition({}); return ""; } catch (e) { return e.message; } })()));
  check("described", describeCondition(until) === "“Add to cart” can be clicked and “Sold out” is gone");

  check("how often: at least 5 min when reloading, 1 when not; defaults; at most 3 h", watchEvery(true, 1) === 5 && watchEvery(false, 0.2) === 1 && watchEvery(true) === 10 && watchEvery(false) === 2 && watchEvery(true, 999) === WATCH_LIMITS.maxMinutes);
  check("...the tests' minimum", watchEvery(true, 0.005, 0) === 0.005);
  const w = newWatch({ chatId: "c1", spaceId: "s", url: "https://shop.example/x", title: "X", until, reload: true, every: 10, then: " add it to the cart " }, 1000);
  check("a new watch", w.state === "watching" && w.then === "add it to the cart" && w.ends === 1000 + 7 * 86400000 && /^w/.test(w.id));
  check("text for the card", everyText(w) === "every 10 min, reloading the page" && everyText({ every: 1, reload: false }) === "every minute, without reloading" && everyText({ every: 120, reload: true }) === "every 2 h, reloading the page");
  check("due after its interval (a new one right away)", isDue(w, Date.now()) && !isDue({ ...w, lastCheck: 1000 }, 1000 + 9 * 60000) && isDue({ ...w, lastCheck: 1000 }, 1000 + 10 * 60000) && !isDue({ ...w, state: "fired" }, 1e15));

  const notYet = { text: false, gone: false, button: { found: true, ready: false } };
  check("met only when every part holds", !conditionMet(until, notYet) && !conditionMet(until, { gone: true, button: { found: true, ready: false } }) && conditionMet(until, { gone: true, button: { found: true, ready: true } }) && !conditionMet(until, { error: "x" }));
  check("what the list says", checkNote(until, notYet) === "Not yet: “Add to cart” isn't clickable yet; “Sold out” is still there" && checkNote({ button: "Buy" }, { button: { found: false } }) === "Not yet: no “Buy” button yet" && checkNote(until, { error: "The page couldn't be read." }) === "The page couldn't be read.");

  const cleaned = cleanWatches([
    w,
    { ...w, id: "bad", url: "file:///etc/passwd" },
    { ...w, id: "noUntil", until: {} },
    { ...w, id: "acting", state: "acting", firedAt: 5 },
    { ...w, id: "extra", secret: "nope", until: { button: "Buy", evil: "x" } },
  ]);
  check("saved: only web pages with a condition, only known fields", cleaned.map((x) => x.id).join() === `${w.id},extra,acting` && !("secret" in cleaned[1]) && JSON.stringify(cleaned[1].until) === '{"button":"Buy"}');
  check("...a watch that was acting when Zen quit is saved as fired (it doesn't act again)", cleaned[2].state === "fired");
  const allow = cleanWatches([{ ...w, id: "a1", allowAll: true }, { ...w, id: "a2", then: "", allowAll: true }, { ...w, id: "a3", allowAll: "yes" }]);
  check("“without asking” is kept only for a watch with something to do, and only as true", allow[0].allowAll === true && allow[1].allowAll === false && allow[2].allowAll === false && newWatch({ ...w }).allowAll === false);
  const many = Array.from({ length: 30 }, (_, i) => ({ ...w, id: "e" + i, state: "stopped", lastCheck: i }));
  check("...ended ones trimmed to the newest 20", cleanWatches(many).length === 20 && cleanWatches(many)[0].id === "e29");
  const wake = watchWakeText(w, "Shop: X");
  check("the wake message says what happened, what to do, and where", /“Add to cart” can be clicked and “Sold out” is gone/.test(wake) && /the user asked you to: add it to the cart/.test(wake) && /That page is your current tab \(its title, from the page: “Shop: X”\)/.test(wake));
  done();
})().catch(crash);
