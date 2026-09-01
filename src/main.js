const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const GITHUB_REPO = "browerg/dnd-vtt";
const REPO_ZIP = "https://github.com/browerg/dnd-vtt/archive/refs/heads/rwby-theme.zip";
const BRANCH = "rwby-theme";
const VERSION = app.getVersion();
const LAUNCHER_RELEASE_PREFIX = "launcher-v";
const BACKUP_FORMAT = "vivid-realms-backup";
const BACKUP_VERSION = 1;
const BACKUP_RELATIVE_PATHS = ["server/data", "uploads", "server/uploads"];

let win;
let processes = { server: null, client: null, tunnel: null };
let tunnelBuffer = "";
let busy = false;
let activeHostMode = "production";
let activeGameRoot = null;
let activeInviteUrl = "";
let discordAnnouncementAttempted = false;
let discordEndAnnouncementAttempted = false;
let sessionStartedAt = null;
let updateNoticeKey = "";
let lastUpdateCheck = null;
let lastUpdateCheckAt = 0;
const AUTO_UPDATE_CACHE_MS = 15 * 60 * 1000;
const MANUAL_UPDATE_THROTTLE_MS = 30 * 1000;

const paths = {
  root: path.join(app.getPath("userData"), "game"),
  temp: path.join(app.getPath("temp"), "vivid-realms-update"),
  zip: path.join(app.getPath("temp"), "vivid-realms-rwby.zip"),
  backups: path.join(app.getPath("userData"), "backups"),
  settings: path.join(app.getPath("userData"), "launcher-settings.json"),
  vttVersion: path.join(app.getPath("userData"), "game-version.json"),
  launcherUpdate: path.join(app.getPath("temp"), "Vivid-Realms-VTT-Launcher-Update.exe"),
};

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function progress(percent, title, detail = "", indeterminate = false) {
  send("launcher:progress", { percent, title, detail, indeterminate });
  if (win && !win.isDestroyed()) {
    win.setProgressBar(indeterminate ? 2 : Math.max(0, Math.min(1, percent / 100)), {
      mode: indeterminate ? "indeterminate" : "normal",
    });
  }
}

function log(line) {
  send("launcher:log", String(line).trim());
}

function normalizeDiscordWebhookUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Enter a Discord webhook URL first.");

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("That does not look like a valid Discord webhook URL.");
  }

  const allowedHosts = new Set([
    "discord.com",
    "discordapp.com",
    "canary.discord.com",
    "ptb.discord.com",
  ]);
  const webhookPath = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+\/?$/i;
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname.toLowerCase()) || !webhookPath.test(parsed.pathname)) {
    throw new Error("Use an incoming Discord webhook URL from discord.com/api/webhooks/…");
  }

  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeSessionNotesUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("That does not look like a valid Session Notes URL.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Session Notes must use an http:// or https:// link.");
  }
  return parsed.toString();
}

function normalizeDiscordSessionAnnouncement(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (text.length > 1200) {
    throw new Error("Session announcement must be 1,200 characters or fewer.");
  }
  return text;
}

function formatSessionDuration(durationMs) {
  const totalMinutes = Math.max(1, Math.round(Number(durationMs || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return minutes + "m";
  if (!minutes) return hours + "h";
  return hours + "h " + minutes + "m";
}

async function loadLauncherSettings() {
  const defaults = {
    discordWebhookUrl: "",
    discordSessionNotesUrl: "",
    discordSessionAnnouncement: "",
    discordEnabled: false,
    discordAnnounceStart: true,
    discordAnnounceEnd: true,
    updateChecksEnabled: true,
    updateCache: null,
  };

  try {
    const parsed = JSON.parse(await fsp.readFile(paths.settings, "utf8"));
    return {
      discordWebhookUrl: typeof parsed?.discordWebhookUrl === "string" ? parsed.discordWebhookUrl : defaults.discordWebhookUrl,
      discordSessionNotesUrl: typeof parsed?.discordSessionNotesUrl === "string" ? parsed.discordSessionNotesUrl : defaults.discordSessionNotesUrl,
      discordSessionAnnouncement: typeof parsed?.discordSessionAnnouncement === "string" ? parsed.discordSessionAnnouncement : defaults.discordSessionAnnouncement,
      discordEnabled: typeof parsed?.discordEnabled === "boolean" ? parsed.discordEnabled : defaults.discordEnabled,
      discordAnnounceStart: typeof parsed?.discordAnnounceStart === "boolean" ? parsed.discordAnnounceStart : defaults.discordAnnounceStart,
      discordAnnounceEnd: typeof parsed?.discordAnnounceEnd === "boolean" ? parsed.discordAnnounceEnd : defaults.discordAnnounceEnd,
      updateChecksEnabled: typeof parsed?.updateChecksEnabled === "boolean" ? parsed.updateChecksEnabled : defaults.updateChecksEnabled,
      updateCache: parsed?.updateCache && typeof parsed.updateCache === "object" ? parsed.updateCache : defaults.updateCache,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") log("[discord] Launcher settings could not be read; using defaults.");
    return defaults;
  }
}

async function saveLauncherSettings(patch) {
  const current = await loadLauncherSettings();
  const next = { ...current, ...patch };
  await fsp.mkdir(path.dirname(paths.settings), { recursive: true });
  await fsp.writeFile(paths.settings, JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function executeDiscordWebhook(webhookUrl, payload, { withComponents = false } = {}) {
  const normalized = normalizeDiscordWebhookUrl(webhookUrl);
  const endpoint = new URL(normalized);
  endpoint.searchParams.set("wait", "true");
  if (withComponents) endpoint.searchParams.set("with_components", "true");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      const error = new Error("Discord returned HTTP " + response.status + (body ? ": " + body : ""));
      error.discordStatus = response.status;
      throw error;
    }
    return true;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Discord did not respond within 8 seconds.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function testDiscordWebhook(webhookUrl) {
  await executeDiscordWebhook(webhookUrl, {
    username: "Vivid Realms",
    content: "✅ Vivid Realms Discord connection is working.",
    allowed_mentions: { parse: [] },
  });
}

async function announceDiscordSession(inviteUrl) {
  if (discordAnnouncementAttempted) return;
  discordAnnouncementAttempted = true;

  const settings = await loadLauncherSettings();
  if (!settings.discordEnabled || !settings.discordWebhookUrl || !settings.discordAnnounceStart) return;

  const notesUrl = settings.discordSessionNotesUrl;
  const announcement = settings.discordSessionAnnouncement;
  const contentLines = ["🎲 **Vivid Realms is Live!**"];
  if (announcement) contentLines.push(announcement);
  else contentLines.push("The table is online and ready for players.");
  contentLines.push("**Join Session:** " + inviteUrl);
  if (notesUrl) contentLines.push("📝 **Session Notes:** " + notesUrl);

  const basePayload = {
    username: "Vivid Realms",
    content: contentLines.join("\n"),
    embeds: [
      {
        title: "Join the Vivid Realms session",
        description: notesUrl
          ? "The current VTT session is online. Join the table or open the shared session notes below."
          : "The current VTT session is online. Use the link below to join the table.",
        url: inviteUrl,
      },
    ],
    allowed_mentions: { parse: [] },
  };

  const buttons = [{ type: 2, style: 5, label: "Join Session", url: inviteUrl }];
  if (notesUrl) buttons.push({ type: 2, style: 5, label: "Session Notes", url: notesUrl });

  try {
    try {
      await executeDiscordWebhook(
        settings.discordWebhookUrl,
        { ...basePayload, components: [{ type: 1, components: buttons }] },
        { withComponents: true }
      );
    } catch (error) {
      if (error?.discordStatus !== 400) throw error;
      log("[discord] Link buttons were rejected; retrying with clickable URLs only.");
      await executeDiscordWebhook(settings.discordWebhookUrl, basePayload);
    }
    log("[discord] Session-live notification sent.");
    send("launcher:discord-status", { kind: "sent", message: "Discord session-start notification sent." });
  } catch (error) {
    log("[discord] Session-start notification failed: " + (error.message || String(error)));
    send("launcher:discord-status", {
      kind: "error",
      message: "Discord start notification failed, but hosting is still online.",
    });
  }
}

async function announceDiscordSessionEnded() {
  if (discordEndAnnouncementAttempted || !sessionStartedAt) return;
  discordEndAnnouncementAttempted = true;

  const settings = await loadLauncherSettings();
  if (!settings.discordEnabled || !settings.discordWebhookUrl || !settings.discordAnnounceEnd) return;

  const notesUrl = settings.discordSessionNotesUrl;
  const duration = formatSessionDuration(Date.now() - sessionStartedAt);
  const contentLines = [
    "🌙 **Vivid Realms Session Ended**",
    "The table is closed for tonight.",
    "**Session Length:** " + duration,
  ];
  if (notesUrl) contentLines.push("📝 **Session Notes:** " + notesUrl);
  contentLines.push("*Until next time, adventurers.*");

  const basePayload = {
    username: "Vivid Realms",
    content: contentLines.join("\n"),
    embeds: [
      {
        title: "Session Ended",
        description: "Thanks for playing. Session length: **" + duration + "**" +
          (notesUrl ? "\n\nUse the Session Notes link to review or update the campaign notes." : ""),
      },
    ],
    allowed_mentions: { parse: [] },
  };

  try {
    if (notesUrl) {
      try {
        await executeDiscordWebhook(
          settings.discordWebhookUrl,
          {
            ...basePayload,
            components: [
              {
                type: 1,
                components: [{ type: 2, style: 5, label: "Session Notes", url: notesUrl }],
              },
            ],
          },
          { withComponents: true }
        );
      } catch (error) {
        if (error?.discordStatus !== 400) throw error;
        log("[discord] Session Notes button was rejected; retrying with the clickable URL only.");
        await executeDiscordWebhook(settings.discordWebhookUrl, basePayload);
      }
    } else {
      await executeDiscordWebhook(settings.discordWebhookUrl, basePayload);
    }
    log("[discord] Session-ended notification sent (" + duration + ").");
    send("launcher:discord-status", { kind: "sent", message: "Discord session-ended notification sent." });
  } catch (error) {
    log("[discord] Session-ended notification failed: " + (error.message || String(error)));
    send("launcher:discord-status", {
      kind: "error",
      message: "Discord end notification failed; the VTT will still shut down normally.",
    });
  }
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function quoteForPsSingle(value) {
  return String(value).replaceAll("'", "''");
}

async function refreshWindowsPath() {
  if (process.platform !== "win32") return;
  const machinePath = await new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine')"],
      { windowsHide: true },
      (error, stdout) => resolve(error ? "" : String(stdout).trim())
    );
  });
  const userPath = await new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"],
      { windowsHide: true },
      (error, stdout) => resolve(error ? "" : String(stdout).trim())
    );
  });
  process.env.Path = [machinePath, userPath, process.env.Path].filter(Boolean).join(";");
}

function findCommand(command) {
  return new Promise((resolve) => {
    const p = spawn("where.exe", [command], { windowsHide: true });
    let output = "";
    p.stdout?.on("data", (d) => { output += String(d); });
    p.on("close", (code) => {
      const first = output.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(code === 0 && first ? first : null);
    });
    p.on("error", () => resolve(null));
  });
}

async function commandExists(command) {
  return Boolean(await findCommand(command));
}

async function resolveNpmInvocation() {
  if (process.platform !== "win32") {
    return { command: "npm", prefixArgs: [] };
  }

  const bundledNode = path.join(process.resourcesPath, "runtime", "node", "node.exe");
  const bundledNpm = path.join(
    process.resourcesPath,
    "runtime",
    "node",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );

  if (fs.existsSync(bundledNode) && fs.existsSync(bundledNpm)) {
    return {
      command: bundledNode,
      prefixArgs: [bundledNpm],
    };
  }

  await refreshWindowsPath();

  const nodeExe =
    (await findCommand("node.exe")) ||
    "C:\\Program Files\\nodejs\\node.exe";

  const npmCliCandidates = [
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    path.join(path.dirname(nodeExe), "node_modules", "npm", "bin", "npm-cli.js"),
  ];

  const npmCli = npmCliCandidates.find((candidate) => fs.existsSync(candidate));

  if (!fs.existsSync(nodeExe)) {
    throw new Error("The bundled Node.js runtime is missing.");
  }

  if (!npmCli) {
    throw new Error("The bundled npm runtime is missing.");
  }

  return {
    command: nodeExe,
    prefixArgs: [npmCli],
  };
}

function quoteForCmd(value) {
  const text = String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function spawnPortable(command, args, options = {}) {
  const lower = String(command).toLowerCase();
  const isWindowsScript =
    process.platform === "win32" &&
    (lower.endsWith(".cmd") || lower.endsWith(".bat"));

  if (isWindowsScript) {
    const commandLine =
      `""${String(command).replaceAll('"', '""')}"` +
      (args.length ? ` ${args.map(quoteForCmd).join(" ")}` : "") +
      `"`;

    return spawn(
      process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", commandLine],
      {
        windowsHide: true,
        shell: false,
        ...options,
      }
    );
  }

  return spawn(command, args, {
    windowsHide: true,
    shell: false,
    ...options,
  });
}

function getRuntimeEnvironment(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };

  if (process.platform === "win32") {
    const bundledNodeDirectory = path.join(process.resourcesPath, "runtime", "node");
    if (fs.existsSync(path.join(bundledNodeDirectory, "node.exe"))) {
      env.Path = [bundledNodeDirectory, env.Path || env.PATH || ""]
        .filter(Boolean)
        .join(";");
      env.PATH = env.Path;
    }
  }

  return env;
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(`> ${command} ${args.join(" ")}`);
    const child = spawnPortable(command, args, {
      ...options,
      env: getRuntimeEnvironment(options.env || {}),
    });
    child.stdout?.on("data", (d) => log(d));
    child.stderr?.on("data", (d) => log(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))
    );
  });
}

async function ensureWingetPackage(id, executable, label, start, end) {
  if (await commandExists(executable)) {
    progress(end, `${label} ready`, "Already installed.");
    return;
  }
  progress(start, `Installing ${label}`, "Windows Package Manager is working…", true);
  await run("winget.exe", [
    "install", "--id", id, "--exact", "--source", "winget",
    "--accept-package-agreements", "--accept-source-agreements", "--silent",
  ]);
  await refreshWindowsPath();
  progress(end, `${label} ready`, "Installation complete.");
}

async function downloadWithProgress(url, destination, startPercent, endPercent) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  const total = Number(response.headers.get("content-length") || 0);
  let received = 0;
  const started = Date.now();
  const file = fs.createWriteStream(destination);

  const stream = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      const ratio = total ? received / total : 0;
      const percent = total
        ? startPercent + ratio * (endPercent - startPercent)
        : startPercent;
      const seconds = Math.max(0.1, (Date.now() - started) / 1000);
      const speed = received / seconds;
      progress(
        percent,
        "Downloading VTT files",
        total
          ? `${formatBytes(received)} / ${formatBytes(total)} · ${formatBytes(speed)}/s`
          : `${formatBytes(received)} downloaded`,
        !total
      );
      controller.enqueue(chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body.pipeThrough(stream)),
    file
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function extractZip(zipPath, target) {
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(target, { recursive: true });
  await run("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    `Expand-Archive -LiteralPath '${quoteForPsSingle(zipPath)}' -DestinationPath '${quoteForPsSingle(target)}' -Force`,
  ]);
}

async function compressDirectoryContents(sourceDir, destinationZip) {
  await fsp.mkdir(path.dirname(destinationZip), { recursive: true });
  await run("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    `Compress-Archive -Path '${quoteForPsSingle(path.join(sourceDir, '*'))}' -DestinationPath '${quoteForPsSingle(destinationZip)}' -Force`,
  ]);
}

async function locateExtractedRoot(tempRoot) {
  const entries = await fsp.readdir(tempRoot, { withFileTypes: true });
  const candidate = entries.find((entry) => entry.isDirectory());
  if (!candidate) throw new Error("The downloaded archive did not contain a project folder.");
  return path.join(tempRoot, candidate.name);
}

async function preserveData(oldRoot, newRoot) {
  const oldData = path.join(oldRoot, "server", "data");
  const newData = path.join(newRoot, "server", "data");
  if (fs.existsSync(oldData)) {
    progress(72, "Preserving campaigns", "Copying database, maps, tokens, and uploads…");
    await fsp.mkdir(path.dirname(newData), { recursive: true });
    await fsp.cp(oldData, newData, { recursive: true, force: true });
  }
}

async function swapGame(newRoot) {
  const backup = `${paths.root}.backup`;
  await fsp.rm(backup, { recursive: true, force: true });
  if (fs.existsSync(paths.root)) await fsp.rename(paths.root, backup);
  try {
    await fsp.rename(newRoot, paths.root);
    await fsp.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(backup) && !fs.existsSync(paths.root)) await fsp.rename(backup, paths.root);
    throw error;
  }
}

function isHostingActive() {
  return Boolean(processes.server || processes.client || processes.tunnel);
}

async function ensureStoppedForAction(actionLabel) {
  if (!isHostingActive()) return true;
  const result = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Stop Hosting", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: `${actionLabel} requires offline mode`,
    message: `${actionLabel} works best while the VTT is offline.`,
    detail: "The launcher can stop hosting now, then continue automatically.",
  });
  if (result.response !== 0) return false;
  await stopHosting();
  return true;
}

function getBackupTargets() {
  return BACKUP_RELATIVE_PATHS
    .map((relativePath) => ({ relativePath, absolutePath: path.join(paths.root, relativePath) }))
    .filter((entry) => fs.existsSync(entry.absolutePath));
}

async function ensureInstalledForDataAction() {
  if (!fs.existsSync(paths.root)) {
    throw new Error("Install the VTT before using backups.");
  }
}

async function writeBackupManifest(stagingRoot, targets) {
  const info = {
    format: BACKUP_FORMAT,
    backupVersion: BACKUP_VERSION,
    launcherVersion: VERSION,
    branch: BRANCH,
    createdAt: new Date().toISOString(),
    entries: targets.map((entry) => entry.relativePath.replaceAll("\\", "/")),
  };
  await fsp.writeFile(path.join(stagingRoot, "backup-info.json"), JSON.stringify(info, null, 2), "utf8");
  await fsp.writeFile(
    path.join(stagingRoot, "manifest.json"),
    JSON.stringify(
      {
        files: info.entries,
        createdAt: info.createdAt,
        format: info.format,
      },
      null,
      2
    ),
    "utf8"
  );
}

async function stageBackupPayload(stagingRoot, targets) {
  for (const entry of targets) {
    const destination = path.join(stagingRoot, "payload", entry.relativePath);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.cp(entry.absolutePath, destination, { recursive: true, force: true });
  }
}

async function createBackupZip(destinationZip, mode = "manual") {
  await ensureInstalledForDataAction();
  const targets = getBackupTargets();
  if (!targets.length) {
    throw new Error("No VTT data folders were found to back up.");
  }

  const stagingRoot = path.join(app.getPath("temp"), `vivid-realms-backup-${Date.now()}`);
  await fsp.rm(stagingRoot, { recursive: true, force: true });
  await fsp.mkdir(stagingRoot, { recursive: true });

  try {
    progress(18, mode === "safety" ? "Preparing safety backup" : "Preparing backup", "Gathering your VTT data…", true);
    await stageBackupPayload(stagingRoot, targets);
    await writeBackupManifest(stagingRoot, targets);

    progress(72, mode === "safety" ? "Compressing safety backup" : "Compressing backup", path.basename(destinationZip), true);
    await fsp.rm(destinationZip, { force: true });
    await compressDirectoryContents(stagingRoot, destinationZip);
    return destinationZip;
  } finally {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function backupData() {
  if (busy) return;
  busy = true;
  try {
    send("launcher:state", { busy: true });
    const ok = await ensureStoppedForAction("Back Up VTT Data");
    if (!ok) return;

    const defaultPath = path.join(app.getPath("documents"), `Vivid-Realms-Backup-${nowStamp()}.zip`);
    const save = await dialog.showSaveDialog(win, {
      title: "Back Up VTT Data",
      defaultPath,
      filters: [{ name: "Vivid Realms Backup", extensions: ["zip"] }],
    });
    if (save.canceled || !save.filePath) return;

    log("Creating VTT backup package…");
    const created = await createBackupZip(save.filePath, "manual");
    progress(100, "Backup complete", created);
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
    await dialog.showMessageBox(win, {
      type: "info",
      title: "Backup complete",
      message: "Your VTT data backup is ready.",
      detail: created,
    });
  } catch (error) {
    progress(0, "Backup failed", error.message || String(error));
    send("launcher:error", { message: error.message || String(error) });
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
  } finally {
    busy = false;
    send("launcher:state", { busy: false });
  }
}

async function createSafetyBackup() {
  await fsp.mkdir(paths.backups, { recursive: true });
  const safetyPath = path.join(paths.backups, `Vivid-Realms-Safety-Backup-${nowStamp()}.zip`);
  await createBackupZip(safetyPath, "safety");
  return safetyPath;
}

function validateBackupInfo(info) {
  if (!info || info.format !== BACKUP_FORMAT) {
    throw new Error("That ZIP does not look like a Vivid Realms backup.");
  }
  if (!Array.isArray(info.entries) || !info.entries.length) {
    throw new Error("The backup manifest is missing its data entries.");
  }
  for (const entry of info.entries) {
    if (typeof entry !== "string" || !BACKUP_RELATIVE_PATHS.includes(entry)) {
      throw new Error(`The backup includes an unexpected path: ${String(entry)}`);
    }
  }
}

async function restoreBackup() {
  if (busy) return;
  busy = true;
  try {
    send("launcher:state", { busy: true });
    await ensureInstalledForDataAction();
    const ok = await ensureStoppedForAction("Restore Backup");
    if (!ok) return;

    const pick = await dialog.showOpenDialog(win, {
      title: "Restore VTT Backup",
      properties: ["openFile"],
      filters: [{ name: "Vivid Realms Backup", extensions: ["zip"] }],
    });
    if (pick.canceled || !pick.filePaths?.[0]) return;

    const selectedZip = pick.filePaths[0];
    const extractedRoot = path.join(app.getPath("temp"), `vivid-realms-restore-${Date.now()}`);

    progress(12, "Reading backup", path.basename(selectedZip), true);
    await extractZip(selectedZip, extractedRoot);

    const infoPath = path.join(extractedRoot, "backup-info.json");
    if (!fs.existsSync(infoPath)) {
      throw new Error("This backup ZIP is missing backup-info.json.");
    }

    const info = JSON.parse(await fsp.readFile(infoPath, "utf8"));
    validateBackupInfo(info);

    progress(28, "Creating safety backup", "Saving your current VTT data before restore…", true);
    const safetyZip = await createSafetyBackup();

    progress(62, "Restoring backup", "Replacing the current VTT data…", true);
    for (const relativePath of info.entries) {
      const source = path.join(extractedRoot, "payload", relativePath);
      const destination = path.join(paths.root, relativePath);
      if (!fs.existsSync(source)) {
        throw new Error(`The backup is missing payload for ${relativePath}.`);
      }
      await fsp.rm(destination, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.cp(source, destination, { recursive: true, force: true });
    }

    await fsp.rm(extractedRoot, { recursive: true, force: true });
    progress(100, "Restore complete", "Your VTT data has been restored.");
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
    await dialog.showMessageBox(win, {
      type: "info",
      title: "Restore complete",
      message: "Your VTT data has been restored.",
      detail: `Safety backup created at:\n${safetyZip}`,
    });
  } catch (error) {
    progress(0, "Restore failed", error.message || String(error));
    send("launcher:error", { message: error.message || String(error) });
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
  } finally {
    busy = false;
    send("launcher:state", { busy: false });
  }
}

async function openBackupsFolder() {
  await fsp.mkdir(paths.backups, { recursive: true });
  await shell.openPath(paths.backups);
}


function compareVersions(a, b) {
  const pa = String(a || "").replace(/^v/i, "").split(".").map((n) => Number(n) || 0);
  const pb = String(b || "").replace(/^v/i, "").split(".").map((n) => Number(n) || 0);
  const size = Math.max(pa.length, pb.length);
  for (let i = 0; i < size; i += 1) {
    const left = pa[i] || 0;
    const right = pb[i] || 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

function formatUpdateError(error) {
  const message = String(error?.message || error || "Update check failed");
  if (/rate limit/i.test(message)) return message;
  if (/GitHub returned HTTP 403/i.test(message)) return "GitHub temporarily refused the update check";
  if (/AbortError|aborted|timeout/i.test(message)) return "GitHub update check timed out";
  return message;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": "Vivid-Realms-Launcher/" + VERSION,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = Number(response.headers.get("x-ratelimit-reset") || 0);
      if (response.status === 403 && remaining === "0") {
        const resetText = reset ? ` · resets ${new Date(reset * 1000).toLocaleTimeString()}` : "";
        throw new Error("GitHub rate limit reached" + resetText);
      }
      throw new Error("GitHub returned HTTP " + response.status);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getRemoteVttHead() {
  const branch = await fetchJson(
    `https://api.github.com/repos/${GITHUB_REPO}/branches/${encodeURIComponent(BRANCH)}`
  );
  return {
    sha: String(branch?.commit?.sha || ""),
    shortSha: String(branch?.commit?.sha || "").slice(0, 7),
    message: String(branch?.commit?.commit?.message || "").split("\n")[0],
  };
}

async function getLatestLauncherRelease() {
  const releases = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`);
  const release = Array.isArray(releases)
    ? releases.find((item) => !item?.draft && String(item?.tag_name || "").startsWith(LAUNCHER_RELEASE_PREFIX))
    : null;
  if (!release) return null;

  const version = String(release.tag_name).slice(LAUNCHER_RELEASE_PREFIX.length).replace(/^v/i, "");
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => /\.exe$/i.test(String(item?.name || "")))
    : null;

  return {
    version,
    tag: String(release.tag_name || ""),
    name: String(release.name || release.tag_name || ""),
    publishedAt: String(release.published_at || ""),
    assetName: String(asset?.name || ""),
    assetUrl: String(asset?.browser_download_url || ""),
    htmlUrl: String(release.html_url || ""),
  };
}

async function execCapture(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message || error).trim();
        reject(new Error(detail || `${command} failed.`));
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

async function readManagedVttVersion() {
  try {
    const parsed = JSON.parse(await fsp.readFile(paths.vttVersion, "utf8"));
    return {
      sha: String(parsed?.sha || ""),
      shortSha: String(parsed?.sha || "").slice(0, 7),
      updatedAt: String(parsed?.updatedAt || ""),
    };
  } catch {
    return { sha: "", shortSha: "", updatedAt: "" };
  }
}

async function getLocalProjectHead(localProjectPath) {
  const root = String(localProjectPath || "").trim();
  if (!root || !fs.existsSync(root)) return { sha: "", shortSha: "", path: root };
  try {
    const sha = await execCapture("git", ["-C", root, "rev-parse", "HEAD"]);
    return { sha, shortSha: sha.slice(0, 7), path: root };
  } catch {
    return { sha: "", shortSha: "", path: root };
  }
}

async function checkForUpdates(options = {}) {
  const settings = await loadLauncherSettings();
  const now = Date.now();
  const manual = options.manual === true;

  if (!manual && settings.updateChecksEnabled === false) {
    return { ok: true, disabled: true, launcherVersion: VERSION };
  }

  // Repeated clicks in the same session should not hammer GitHub.
  if (lastUpdateCheck && now - lastUpdateCheckAt < MANUAL_UPDATE_THROTTLE_MS) {
    return { ...lastUpdateCheck, cached: true };
  }

  // Automatic checks survive launcher restarts for 15 minutes. Manual Check now bypasses this cache.
  const cached = settings.updateCache;
  const cachedAt = Number(cached?.timestamp || 0);
  const cachedResult = cached?.result;
  if (!manual && cachedResult && cachedResult.launcherVersion === VERSION && now - cachedAt < AUTO_UPDATE_CACHE_MS) {
    lastUpdateCheck = cachedResult;
    lastUpdateCheckAt = cachedAt;
    return { ...cachedResult, cached: true };
  }

  const [remoteVttResult, launcherReleaseResult] = await Promise.allSettled([
    getRemoteVttHead(),
    getLatestLauncherRelease(),
  ]);

  const remoteVtt = remoteVttResult.status === "fulfilled" ? remoteVttResult.value : null;
  const launcherRelease = launcherReleaseResult.status === "fulfilled" ? launcherReleaseResult.value : null;
  const vttCheckError = remoteVttResult.status === "rejected" ? formatUpdateError(remoteVttResult.reason) : "";
  const launcherCheckError = launcherReleaseResult.status === "rejected" ? formatUpdateError(launcherReleaseResult.reason) : "";

  const useLocalProject = Boolean(options.useLocalProject);
  const local = useLocalProject
    ? await getLocalProjectHead(options.localProjectPath)
    : await readManagedVttVersion();

  const vttUpdateAvailable = Boolean(remoteVtt?.sha && local?.sha && remoteVtt.sha !== local.sha);
  const launcherUpdateAvailable = Boolean(
    launcherRelease?.version && compareVersions(launcherRelease.version, VERSION) > 0
  );

  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    launcherVersion: VERSION,
    launcherUpdateAvailable,
    launcherRelease,
    launcherCheckError,
    vttCheckError,
    vttUpdateAvailable,
    vtt: {
      localSha: local?.sha || "",
      localShortSha: local?.shortSha || "",
      remoteSha: remoteVtt?.sha || "",
      remoteShortSha: remoteVtt?.shortSha || "",
      remoteMessage: remoteVtt?.message || "",
      source: useLocalProject ? "local-project" : "managed",
    },
  };

  lastUpdateCheck = result;
  lastUpdateCheckAt = now;
  await saveLauncherSettings({ updateCache: { timestamp: now, result } });

  const noticeKey = `${result.vtt.remoteSha}|${launcherRelease?.version || ""}`;
  if ((vttUpdateAvailable || launcherUpdateAvailable) && noticeKey !== updateNoticeKey) {
    updateNoticeKey = noticeKey;
    send("launcher:update-status", result);
  }

  return result;
}

async function writeManagedVttVersion(remoteVtt) {
  if (!remoteVtt?.sha) return;
  await fsp.writeFile(
    paths.vttVersion,
    JSON.stringify({
      sha: remoteVtt.sha,
      branch: BRANCH,
      message: remoteVtt.message || "",
      updatedAt: new Date().toISOString(),
    }, null, 2),
    "utf8"
  );
}

async function updateLocalGitProject(options = {}) {
  const root = String(options.localProjectPath || "").trim();
  if (!root || !fs.existsSync(path.join(root, ".git"))) {
    throw new Error("Local project is not a Git repository: " + root);
  }

  const dirty = await execCapture("git", ["-C", root, "status", "--porcelain"]);
  if (dirty) {
    throw new Error("The local VTT project has uncommitted changes. Commit or stash them before updating.");
  }

  progress(12, "Checking VTT repository", "Fetching " + BRANCH + " from GitHub...", true);
  await execCapture("git", ["-C", root, "fetch", "origin", BRANCH]);

  const before = await execCapture("git", ["-C", root, "rev-parse", "HEAD"]);
  const remote = await execCapture("git", ["-C", root, "rev-parse", "origin/" + BRANCH]);

  if (before === remote) {
    progress(100, "VTT already current", "Local project is already at " + before.slice(0, 7) + ".");
    return { before, after: before, changed: false };
  }

  progress(34, "Updating VTT source", before.slice(0, 7) + " -> " + remote.slice(0, 7), true);
  await execCapture("git", ["-C", root, "merge", "--ff-only", "origin/" + BRANCH]);

  const npm = await resolveNpmInvocation();
  progress(56, "Installing dependencies", "Refreshing packages after the update...", true);
  await run(npm.command, [...npm.prefixArgs, "install"], { cwd: root });

  progress(78, "Building client", "Compiling the latest VTT interface...", true);
  await run(npm.command, [...npm.prefixArgs, "run", "build", "--workspace=client"], { cwd: root });

  progress(91, "Validating server", "Checking the server TypeScript build...", true);
  await run(npm.command, [...npm.prefixArgs, "exec", "--workspace=server", "--", "tsc", "--noEmit"], { cwd: root });

  const after = await execCapture("git", ["-C", root, "rev-parse", "HEAD"]);
  progress(100, "VTT updated", "Local project is now at " + after.slice(0, 7) + ".");
  return { before, after, changed: true };
}

async function installLatestLauncherUpdate() {
  if (busy) return { ok: false, message: "The launcher is busy." };
  busy = true;
  send("launcher:state", { busy: true });
  try {
    progress(8, "Checking launcher update", "Looking for the latest Vivid Realms release...", true);
    const release = await getLatestLauncherRelease();
    if (!release?.version || compareVersions(release.version, VERSION) <= 0) {
      progress(100, "Launcher is current", "You already have the newest launcher.");
      return { ok: true, current: true, version: VERSION };
    }
    if (!release.assetUrl) {
      throw new Error("The latest launcher release does not have a Windows installer attached.");
    }

    const response = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Install Update", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      title: "Launcher update available",
      message: `Vivid Realms Launcher ${release.version} is available.`,
      detail: `You are using ${VERSION}. The installer will download, open, and then this launcher will close.`,
    });
    if (response.response !== 0) {
      progress(100, "Update cancelled", "Launcher update was not installed.");
      return { ok: true, cancelled: true };
    }

    progress(20, "Downloading launcher update", release.assetName || `Launcher ${release.version}`, true);
    await downloadWithProgress(release.assetUrl, paths.launcherUpdate, 20, 92);
    progress(95, "Opening installer", "The new launcher will replace this version.");

    const child = spawn(paths.launcherUpdate, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    setTimeout(() => app.quit(), 600);
    return { ok: true, launched: true, version: release.version };
  } catch (error) {
    progress(0, "Launcher update failed", error.message || String(error));
    return { ok: false, message: error.message || String(error) };
  } finally {
    busy = false;
    send("launcher:state", { busy: false });
  }
}

async function installOrUpdate(options = {}) {
  if (busy) return;
  busy = true;
  try {
    send("launcher:state", { busy: true });

    if (options.useLocalProject) {
      await updateLocalGitProject(options);
      if (win && !win.isDestroyed()) win.setProgressBar(-1);
      send("launcher:installed", { installed: true, version: VERSION });
      return;
    }

    progress(2, "Preparing installation", "Checking required tools...");
    let remoteVtt = null;
    try {
      remoteVtt = await getRemoteVttHead();
    } catch (error) {
      log("[update] Could not read the remote commit before downloading: " + (error.message || String(error)));
    }
    progress(31, "Preparing download", "Connecting to GitHub...");
    await downloadWithProgress(REPO_ZIP, paths.zip, 32, 66);

    progress(67, "Extracting VTT", "Unpacking game files…", true);
    await extractZip(paths.zip, paths.temp);
    const extractedRoot = await locateExtractedRoot(paths.temp);
    await preserveData(paths.root, extractedRoot);

    progress(75, "Installing dependencies", "This can take several minutes on the first install…", true);
    const npm = await resolveNpmInvocation();
    await run(npm.command, [...npm.prefixArgs, "install"], { cwd: extractedRoot });

    progress(89, "Building client", "Optimizing the VTT interface…", true);
    await run(npm.command, [...npm.prefixArgs, "run", "build", "--workspace=client"], { cwd: extractedRoot });

    progress(95, "Validating server", "Checking the server build…", true);
    await run(npm.command, [...npm.prefixArgs, "exec", "--workspace=server", "--", "tsc", "--noEmit"], { cwd: extractedRoot });

    progress(98, "Finishing installation", "Moving the verified files into place…");
    await swapGame(extractedRoot);
    await writeManagedVttVersion(remoteVtt);
    await fsp.rm(paths.temp, { recursive: true, force: true });
    await fsp.rm(paths.zip, { force: true });

    progress(100, "Ready to host", "Vivid Realms VTT is installed.");
    send("launcher:installed", { installed: true, version: VERSION });
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
  } catch (error) {
    progress(0, "Installation failed", error.message || String(error));
    send("launcher:error", { message: error.message || String(error) });
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
  } finally {
    busy = false;
    send("launcher:state", { busy: false });
  }
}


async function killListenersOnPorts(ports) {
  if (process.platform !== "win32") return;
  const list = ports.map((port) => Number(port)).filter(Number.isFinite).join(",");
  if (!list) return;
  const script = `
    $ports = @(${list});
    $pids = @();
    foreach ($port in $ports) {
      try {
        $pids += Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
      } catch {}
    }
    $pids = $pids | Where-Object { $_ -and $_ -ne $PID } | Sort-Object -Unique;
    foreach ($processId in $pids) {
      try { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue } catch {}
    }
  `;
  await new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true }, () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
}

function startProcess(key, command, args, cwd) {
  const child = spawnPortable(command, args, {
    cwd,
    env: getRuntimeEnvironment({ FORCE_COLOR: "0" }),
  });
  processes[key] = child;
  child.stdout?.on("data", (d) => {
    log(`[${key}] ${d}`);
    if (key === "tunnel") parseTunnelOutput(String(d));
  });
  child.stderr?.on("data", (d) => {
    log(`[${key}] ${d}`);
    if (key === "tunnel") parseTunnelOutput(String(d));
  });
  child.on("close", () => {
    if (processes[key] === child) processes[key] = null;
  });
  return child;
}

function parseTunnelOutput(text) {
  tunnelBuffer += text;
  const match = tunnelBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (match) {
    const inviteUrl = match[0];
    if (inviteUrl !== activeInviteUrl) {
      activeInviteUrl = inviteUrl;
      if (!sessionStartedAt) sessionStartedAt = Date.now();
      send("launcher:host-ready", { url: inviteUrl });
      progress(100, "World online", "Your invite link is ready.");
      if (win && !win.isDestroyed()) win.setProgressBar(-1);
      void announceDiscordSession(inviteUrl);
    }
  }
  if (tunnelBuffer.length > 20000) tunnelBuffer = tunnelBuffer.slice(-10000);
}

async function waitForOrigin(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status > 0) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startHosting(_event, options = {}) {
  const useLocalProject = Boolean(options?.useLocalProject);
  const requestedLocalPath = String(options?.localProjectPath || "").trim();
  const gameRoot = useLocalProject
    ? (requestedLocalPath || path.join(app.getPath("home"), "dnd-vtt-rwby"))
    : paths.root;

  if (!fs.existsSync(gameRoot) || !fs.existsSync(path.join(gameRoot, "package.json"))) {
    send("launcher:error", {
      message: useLocalProject
        ? `Local development project was not found at ${gameRoot}. Choose the folder that contains package.json.`
        : "Install the VTT before hosting.",
    });
    return;
  }
  if (processes.server || processes.client || processes.tunnel) return;

  activeInviteUrl = "";
  discordAnnouncementAttempted = false;
  discordEndAnnouncementAttempted = false;
  sessionStartedAt = null;

  try {
    await refreshWindowsPath();
    const npm = await resolveNpmInvocation();
    const bundledCloudflared = path.join(process.resourcesPath, "runtime", "cloudflared.exe");
    const cloudflared = process.platform === "win32"
      ? (fs.existsSync(bundledCloudflared)
          ? bundledCloudflared
          : (await findCommand("cloudflared.exe")) || "cloudflared.exe")
      : "cloudflared";

    const devMode = Boolean(options?.devMode);
    activeHostMode = devMode ? "development" : "production";
    activeGameRoot = gameRoot;
    log(`[launcher] Hosting from ${gameRoot}`);
    if (useLocalProject) log("[launcher] Local project mode enabled — using this project's server/data accounts and campaigns.");
    const originPort = devMode ? 5173 : 3001;
    const originUrl = `http://127.0.0.1:${originPort}`;

    progress(8, "Clearing stale hosting processes", "Releasing ports 3001 and 5173 from earlier launcher sessions…", true);
    await killListenersOnPorts([3001, 5173]);

    progress(12, devMode ? "Starting development server" : "Starting VTT server", devMode
      ? "Live reload is enabled for local development."
      : "Loading the verified production build…");

    startProcess(
      "server",
      npm.command,
      [...npm.prefixArgs, "run", devMode ? "dev" : "start", "--workspace=server"],
      gameRoot
    );

    if (devMode) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      progress(38, "Starting Vite client", "Preparing live-reload development tools…");
      startProcess("client", npm.command, [...npm.prefixArgs, "run", "dev", "--workspace=client", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], gameRoot);
    }

    progress(58, "Waiting for VTT", `Checking ${originUrl}…`, true);
    const ready = await waitForOrigin(originUrl, 30000);
    if (!ready) {
      await stopHosting();
      throw new Error(`${devMode ? "Development" : "Production"} server did not become ready on port ${originPort}. Open the launcher log for details.`);
    }

    progress(75, "Opening secure tunnel", "Creating the player invite link…", true);
    tunnelBuffer = "";
    startProcess("tunnel", cloudflared, ["tunnel", "--url", originUrl], gameRoot);
  } catch (error) {
    send("launcher:error", { message: error.message || String(error) });
    progress(0, "Hosting failed", error.message || String(error));
  }
}

async function stopHosting() {
  await announceDiscordSessionEnded();

  for (const key of Object.keys(processes)) {
    const child = processes[key];
    if (child && !child.killed) {
      try {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } catch {}
    }
    processes[key] = null;
  }
  tunnelBuffer = "";
  activeInviteUrl = "";
  discordAnnouncementAttempted = false;
  discordEndAnnouncementAttempted = false;
  sessionStartedAt = null;
  send("launcher:host-stopped", {});
  progress(0, "Offline", "Hosting processes stopped.");
  if (win && !win.isDestroyed()) win.setProgressBar(-1);
}

async function findInstalledUninstaller() {
  if (!app.isPackaged) return null;
  const installDirectory = path.dirname(process.execPath);
  const entries = await fsp.readdir(installDirectory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^uninstall.*\.exe$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  return candidates.length ? path.join(installDirectory, candidates[0]) : null;
}

async function uninstallLauncher() {
  if (busy || Object.values(processes).some(Boolean)) {
    return { ok: false, message: "Stop hosting and wait for launcher tasks to finish before uninstalling." };
  }
  if (!app.isPackaged) {
    return { ok: false, message: "The Uninstall Launcher button is available from the installed Vivid Realms launcher, not a development preview." };
  }

  const uninstaller = await findInstalledUninstaller();
  if (!uninstaller) {
    return {
      ok: false,
      message: "Windows' Vivid Realms uninstaller could not be found. You can still remove it from Settings > Apps > Installed apps.",
    };
  }

  const result = await dialog.showMessageBox(win, {
    type: "warning",
    title: "Uninstall Vivid Realms Launcher",
    message: "Uninstall the Vivid Realms launcher?",
    detail: "This removes the launcher application only. Your VTT game data and launcher backups are kept so you can reinstall without losing campaigns.",
    buttons: ["Cancel", "Uninstall Launcher"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });

  if (result.response !== 1) return { ok: true, cancelled: true };

  const child = spawn(uninstaller, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  setTimeout(() => app.quit(), 350);
  return { ok: true, launched: true };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 980,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: "#080c15",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.once("ready-to-show", () => {
    win.show();
  });
}

ipcMain.handle("launcher:get-settings", async () => {
  const settings = await loadLauncherSettings();
  return {
    discordWebhookUrl: settings.discordWebhookUrl,
    discordSessionNotesUrl: settings.discordSessionNotesUrl,
    discordSessionAnnouncement: settings.discordSessionAnnouncement,
    discordEnabled: settings.discordEnabled,
    discordAnnounceStart: settings.discordAnnounceStart,
    discordAnnounceEnd: settings.discordAnnounceEnd,
    updateChecksEnabled: settings.updateChecksEnabled,
  };
});

ipcMain.handle("launcher:save-discord-webhook", async (_event, value) => {
  try {
    const raw = String(value || "").trim();
    const discordWebhookUrl = raw ? normalizeDiscordWebhookUrl(raw) : "";
    await saveLauncherSettings({ discordWebhookUrl });
    return { ok: true, configured: Boolean(discordWebhookUrl) };
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  }
});

ipcMain.handle("launcher:save-discord-settings", async (_event, value = {}) => {
  try {
    const webhookRaw = String(value?.discordWebhookUrl || "").trim();
    const notesRaw = String(value?.discordSessionNotesUrl || "").trim();
    const announcementRaw = String(value?.discordSessionAnnouncement || "");
    const discordWebhookUrl = webhookRaw ? normalizeDiscordWebhookUrl(webhookRaw) : "";
    const discordSessionNotesUrl = notesRaw ? normalizeSessionNotesUrl(notesRaw) : "";
    const discordSessionAnnouncement = normalizeDiscordSessionAnnouncement(announcementRaw);
    const discordEnabled = value?.discordEnabled === true;
    const discordAnnounceStart = value?.discordAnnounceStart !== false;
    const discordAnnounceEnd = value?.discordAnnounceEnd !== false;
    await saveLauncherSettings({
      discordWebhookUrl,
      discordSessionNotesUrl,
      discordSessionAnnouncement,
      discordEnabled,
      discordAnnounceStart,
      discordAnnounceEnd,
    });
    return { ok: true, configured: Boolean(discordEnabled && discordWebhookUrl) };
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  }
});

ipcMain.handle("launcher:test-discord", async (_event, value) => {
  try {
    await testDiscordWebhook(value);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  }
});

ipcMain.handle("launcher:check-updates", async (_event, options = {}) => {
  try {
    return await checkForUpdates({ ...options, manual: true });
  } catch (error) {
    return { ok: false, message: error.message || String(error), launcherVersion: VERSION };
  }
});

ipcMain.handle("launcher:install-launcher-update", async () => {
  return await installLatestLauncherUpdate();
});

ipcMain.handle("launcher:save-update-settings", async (_event, value = {}) => {
  const updateChecksEnabled = value?.updateChecksEnabled !== false;
  await saveLauncherSettings({ updateChecksEnabled });
  return { ok: true, updateChecksEnabled };
});

ipcMain.handle("launcher:uninstall-launcher", async () => {
  try {
    return await uninstallLauncher();
  } catch (error) {
    log("[launcher] Uninstall failed to launch: " + (error.message || String(error)));
    return { ok: false, message: error.message || String(error) };
  }
});

ipcMain.handle("launcher:get-status", () => ({
  installed: fs.existsSync(paths.root),
  gamePath: paths.root,
  backupsPath: paths.backups,
  version: VERSION,
}));
ipcMain.on("window:minimize", () => win?.minimize());
ipcMain.on("window:close", () => win?.close());
ipcMain.on("launcher:install", () => installOrUpdate());
ipcMain.on("launcher:update", (_event, options = {}) => installOrUpdate(options));
ipcMain.on("launcher:start", startHosting);
ipcMain.on("launcher:stop", stopHosting);
ipcMain.on("launcher:open-local", () => shell.openExternal(activeHostMode === "development" ? "http://localhost:5173" : "http://localhost:3001"));
ipcMain.on("launcher:open-url", (_event, url) => shell.openExternal(url));
ipcMain.on("launcher:copy", (_event, text) => clipboard.writeText(text));
ipcMain.on("launcher:open-folder", () => shell.openPath(activeGameRoot || paths.root));
ipcMain.on("launcher:backup", backupData);
ipcMain.on("launcher:restore-backup", restoreBackup);
ipcMain.on("launcher:open-backups", openBackupsFolder);

app.whenReady().then(createWindow);
app.on("window-all-closed", async () => {
  await stopHosting();
  app.quit();
});
