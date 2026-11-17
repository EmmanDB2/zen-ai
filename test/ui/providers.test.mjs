import { checker, crash } from "../helpers/common.mjs";
import { fakeZen, sleep } from "../helpers/fake-zen.mjs";

const { check, done } = checker();
const CHATS = "/profile/zen-ai/chats";

(async () => {
  const disk = new Map(), transcripts = new Set();
  let zen = await fakeZen({ disk, transcripts, prefs: { provider: "future-ai" } });
  await zen.open();
  await zen.send("Provider migration test");
  await sleep(400);
  const [entry] = zen.index();
  check("new chats persist the available default provider", entry.provider === "claude" && JSON.parse(disk.get(`${CHATS}/${entry.id}.json`)).provider === "claude");
  await zen.close();

  // Emulate a profile saved before provider fields existed.
  const index = JSON.parse(disk.get(`${CHATS}/index.json`));
  const record = JSON.parse(disk.get(`${CHATS}/${entry.id}.json`));
  delete index.chats[0].provider;
  delete record.provider;
  disk.set(`${CHATS}/index.json`, JSON.stringify(index));
  disk.set(`${CHATS}/${entry.id}.json`, JSON.stringify(record));
  zen = await fakeZen({ disk, transcripts });
  await zen.open();
  await zen.send("Continue the old chat");
  await sleep(400);
  check("legacy chats resume the same Claude transcript", zen.spawns.at(-1).resume === entry.sessionId && zen.index()[0].provider === "claude");
  await zen.close();

  // A newer version's provider must not be interpreted as Claude on downgrade.
  const newerIndex = JSON.parse(disk.get(`${CHATS}/index.json`));
  const newerRecord = JSON.parse(disk.get(`${CHATS}/${entry.id}.json`));
  newerIndex.chats[0].provider = newerRecord.provider = "future-ai";
  disk.set(`${CHATS}/index.json`, JSON.stringify(newerIndex));
  disk.set(`${CHATS}/${entry.id}.json`, JSON.stringify(newerRecord));
  transcripts.clear();
  zen = await fakeZen({ disk, transcripts });
  await zen.open();
  check("unavailable provider history stays readable without consulting Claude", zen.bubbles().length === 2 && zen.$(".zai-expired").hidden && zen.spawns.length === 0);
  await zen.send("Do not route this to Claude", { wait: false });
  await sleep(450);
  check("sending reports an unavailable provider and never spawns Claude", /future-ai.*isn't available/.test(zen.$(".zai-thread").textContent) && zen.spawns.length === 0 && !zen.$(".zai-send.zai-stop"));
  check("failed send preserves the saved provider", zen.index()[0].provider === "future-ai");
  check("provider handling causes no window errors", zen.errors.length === 0, zen.errors);
  await zen.close();
  done();
})().catch(crash);
