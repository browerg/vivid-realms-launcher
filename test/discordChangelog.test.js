const test = require("node:test");
const assert = require("node:assert/strict");
const { draft, payload, LIMIT, LINK } = require("../src/discordChangelog");

const release = { heading: "11 September 2026", groups: [
  { name: "Entrance", items: ["Gold button", "Video with sound"] },
  { name: "Badges", items: ["Ten new achievements"] },
] };

test("only selected sections are included, with original wording and preview formatting", () => {
  const result = draft(release, [1]);
  assert.equal(result.description, "**Badges**\n• Ten new achievements");
  assert.equal(result.title, "What's New · 11 September 2026");
  assert.equal(payload(result).embeds[0].description, result.description);
  assert.equal(payload(result).embeds[0].url, LINK);
});
test("empty or invalid selections cannot produce a post", () => {
  for (const selection of [[], [3], [-1], [0.5], ["0"], null]) assert.throws(() => draft(release, selection));
  assert.equal(draft(release, [0, 0]).description, draft(release, [0]).description);
});
test("Discord limits are enforced without truncating a selection", () => {
  assert.equal(payload({ title: "Update", description: "a".repeat(LIMIT) }).embeds[0].description.length, LIMIT);
  for (const value of [null, {}, {title:"",description:"Hi"}, {title:"x".repeat(257),description:"Hi"}, {title:"Hi",description:" "}, {title:"Hi",description:"a".repeat(LIMIT+1)}]) assert.throws(() => payload(value));
});
test("posts cannot enable pings or inject extra webhook fields", () => {
  const result = payload({ title: "Update", description: "@everyone <@123> **new**", content: "surprise", allowed_mentions: {parse:["everyone"]} });
  assert.deepEqual(result.allowed_mentions, {parse:[]});
  assert.equal(result.content, undefined);
  assert.equal(result.embeds.length, 1);
});

// Exercise the real IPC handler with delivery and settings isolated from the
// user's launcher. This test never contacts a webhook or reads local settings.
function senderFixture(delivery) {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/main.js"), "utf8");
  const start = source.indexOf('ipcMain.handle("launcher:send-discord-changelog"');
  const end = source.indexOf('ipcMain.handle("launcher:save-discord-settings"', start);
  let handler;
  const settings = { discordWebhookUrl: "test-destination" };
  require("node:vm").runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, callback) => { handler = callback; } },
    sendingChangelog: false, sentChangelogs: new Set(),
    loadLauncherSettings: async () => settings, executeDiscordWebhook: delivery,
    discordChangelog: { payload }, require,
  });
  return { send: (value) => handler(null, value), settings };
}

test("IPC uses the saved destination and rejects concurrent and duplicate sends", async () => {
  let finish;
  let calls = 0;
  const sender = senderFixture(async (destination, body) => {
    assert.equal(destination, "test-destination");
    assert.equal(body.embeds[0].description, draft(release, [0]).description);
    calls++;
    await new Promise((resolve) => { finish = resolve; });
  });
  const pending = sender.send(draft(release, [0]));
  await new Promise(setImmediate);
  assert.equal((await sender.send(draft(release, [0]))).ok, false);
  finish();
  assert.equal((await pending).ok, true);
  assert.equal((await sender.send(draft(release, [0]))).ok, false);
  assert.equal(calls, 1);
});

test("invalid or unconfigured posts never send; delivery failures never auto-retry", async () => {
  let calls = 0;
  const sender = senderFixture(async () => { calls++; throw new Error("timeout"); });
  assert.equal((await sender.send({title:"Hi",description:"x".repeat(LIMIT+1)})).ok, false);
  sender.settings.discordWebhookUrl = "";
  assert.equal((await sender.send(draft(release, [0]))).ok, false);
  assert.equal(calls, 0);
  sender.settings.discordWebhookUrl = "test-destination";
  const result = await sender.send(draft(release, [0]));
  assert.equal(result.ok, false);
  assert.match(result.message, /Check the Discord channel/);
  assert.equal(calls, 1);
});
