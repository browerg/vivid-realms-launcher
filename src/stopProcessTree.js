const { execFile } = require("node:child_process");

function stopProcessTree(child, execute = execFile) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, timeout: 15000 }, (error) => {
        if (!error || child.exitCode != null || child.signalCode != null) resolve();
        else reject(new Error(`Could not stop VTT process ${child.pid}. Close the other launcher or game terminal and retry.`, { cause: error }));
      });
  });
}

module.exports = { stopProcessTree };
