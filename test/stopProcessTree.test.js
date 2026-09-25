const test = require("node:test");
const assert = require("node:assert/strict");
const { stopProcessTree } = require("../src/stopProcessTree");

test("waits for the entire taskkill operation before allowing an update", async () => {
  let done;
  let stopped = false;
  const result = stopProcessTree({ pid: 123, exitCode: null }, (command, args, options, callback) => {
    assert.equal(command, "taskkill.exe");
    assert.deepEqual(args, ["/PID", "123", "/T", "/F"]);
    assert.equal(options.windowsHide, true);
    done = callback;
  }).then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  done(null);
  await result;
  assert.equal(stopped, true);
});
test("failed termination prevents the update, but already exited processes are harmless", async () => {
  await assert.rejects(stopProcessTree({ pid: 123, exitCode: null }, (_c, _a, _o, done) => done(new Error("denied"))), /Could not stop/);
  await stopProcessTree({ pid: 123, exitCode: 0 }, () => assert.fail("must not kill an exited process"));
  await stopProcessTree(null);
});
