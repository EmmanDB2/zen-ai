// browser_wait's check (the page agent's "watch" action) in Chromium, on a
// lesson page: text showing up or going away (also in a same-site frame), a
// button that gets enabled, and a video's progress. It only reads: the page
// is the same before and after.
import { checker, crash, launchChromium, pageAgentRunner, pageUrl } from "../helpers/common.mjs";

const { check, done } = checker();

(async () => {
  const browser = await launchChromium();
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await page.goto(pageUrl("lesson.html"));
  const agent = await pageAgentRunner(page);
  const snap = await agent({ action: "snapshot" });
  const next = (snap.text.split("\n").find((l) => /button "Next"/.test(l)) || "").match(/\[(e\d+)\]/)?.[1];
  const ask = { action: "watch", text: "completed", gone: "Loading lesson", ref: next };

  const html = await page.evaluate(() => document.documentElement.outerHTML);
  let r = await agent(ask);
  check("before: the text isn't there, the loading note is, Next is disabled", r.text === false && r.gone === false && r.ref === "button Next disabled", r);
  check("before: a video, not started (no length yet)", r.video && r.video.count === 1 && r.video.duration === null && r.video.paused && !r.video.ended, r.video);
  check("watching changes nothing on the page", (await page.evaluate(() => document.documentElement.outerHTML)) === html);

  await page.evaluate(() => lesson.start(2, 1));
  await page.waitForTimeout(600);
  r = await agent(ask);
  check("playing: the loading note is gone, the video is playing partway", r.gone === true && r.text === false && r.video.duration === 2 && !r.video.paused && r.video.time > 0.2 && r.video.time < 2, r);

  await page.evaluate(() => lesson.pause());
  r = await agent(ask);
  check("paused: says so", r.video.paused && !r.video.ended, r.video);

  await page.evaluate(() => lesson.finish());
  r = await agent(ask);
  check("ended: the video has ended", r.video.ended && r.video.time === 2, r.video);
  check("ended: “Completed” is on the page (any case, any spacing)", r.text === true && (await agent({ action: "watch", text: "  COMPLETED   ✓ " })).text === true);
  check("ended: Next's state changed (enabled now)", r.ref === "button Next", r.ref);

  // Text in a same-site frame counts too
  await page.evaluate(() => {
    const f = document.createElement("iframe");
    f.srcdoc = "<p>Download ready</p>";
    document.body.append(f);
    return new Promise((res) => (f.onload = res));
  });
  r = await agent({ action: "watch", text: "download ready" });
  check("text inside a same-site frame is found", r.text === true, r);

  // The element goes away
  await page.evaluate(() => document.getElementById("next").remove());
  r = await agent({ action: "watch", ref: next });
  check("an element that's gone reads as null", r.ref === null, r);
  r = await agent({ action: "watch" });
  check("a plain check still reports the video and the address", r.video && r.video.ended && /lesson\.html/.test(r.url), r);

  await page.evaluate(() => document.getElementById("v").remove());
  r = await agent({ action: "watch" });
  check("no video: null", r.video === null, r);
  await browser.close();
  done();
})().catch(crash);
