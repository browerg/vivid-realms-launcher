const $ = (id) => document.getElementById(id);
const state = {
  installed: false,
  hosting: false,
  busy: false,
  inviteUrl: "",
  devMode: localStorage.getItem("vivid-dev-mode") === "true",
  useLocalProject: localStorage.getItem("vivid-local-project") === "true",
  localProjectPath: localStorage.getItem("vivid-local-project-path") || "C:\\Users\\pirat\\dnd-vtt-rwby",
  launcherUpdateAvailable: false,
  latestLauncherVersion: "",
};

const els = {
  primary: $("primaryAction"),
  primaryLabel: $("primaryLabel"),
  stop: $("stopHosting"),
  open: $("openLocal"),
  update: $("updateButton"),
  updateLauncher: $("updateLauncherButton"),
  checkUpdates: $("checkUpdatesButton"),
  updateChecksEnabled: $("updateChecksEnabled"),
  updateNotice: $("updateNotice"),
  updateNoticeText: $("updateNoticeText"),
  vttUpdateState: $("vttUpdateState"),
  launcherUpdateState: $("launcherUpdateState"),
  uninstallLauncher: $("uninstallLauncherButton"),
  backup: $("backupButton"),
  restore: $("restoreBackupButton"),
  openBackups: $("openBackupsButton"),
  openFolder: $("openFolder"),
  devMode: $("devModeToggle"),
  localProject: $("localProjectToggle"),
  localProjectPath: $("localProjectPath"),
  discordPanel: $("discordPanel"),
  discordOpen: $("discordSettingsButton"),
  discordClose: $("closeDiscordPanel"),
  discordWebhook: $("discordWebhookUrl"),
  discordNotes: $("discordSessionNotesUrl"),
  discordAnnouncement: $("discordSessionAnnouncement"),
  discordEnabled: $("discordEnabled"),
  discordAnnounceStart: $("discordAnnounceStart"),
  discordAnnounceEnd: $("discordAnnounceEnd"),
  saveDiscord: $("saveDiscordButton"),
  testDiscord: $("testDiscordButton"),
  discordStatus: $("discordStatus"),
  progress: $("progressFill"),
  progressTitle: $("progressTitle"),
  progressDetail: $("progressDetail"),
  progressPercent: $("progressPercent"),
  statusText: $("statusText"),
  statusDot: $("statusDot"),
  invitePanel: $("invitePanel"),
  inviteUrl: $("inviteUrl"),
  logPanel: $("logPanel"),
  logOutput: $("logOutput"),
};

function syncActions() {
  els.primary.disabled = state.busy;
  els.stop.disabled = state.busy;
  els.open.disabled = state.busy || !state.installed;
  els.update.disabled = state.busy || !state.installed;
  els.updateLauncher.disabled = state.busy || !state.launcherUpdateAvailable;
  els.checkUpdates.disabled = state.busy;
  els.uninstallLauncher.disabled = state.busy || state.hosting;
  els.backup.disabled = state.busy || !state.installed;
  els.restore.disabled = state.busy || !state.installed;
  els.openBackups.disabled = state.busy;
  els.openFolder.disabled = state.busy || !state.installed;
  els.devMode.disabled = state.busy || state.hosting;
  els.localProject.disabled = state.busy || state.hosting;
  els.localProjectPath.disabled = state.busy || state.hosting || !state.useLocalProject;
  els.saveDiscord.disabled = state.busy;
  els.testDiscord.disabled = state.busy;
  els.discordWebhook.disabled = state.busy;
  els.discordEnabled.disabled = state.busy;
  els.discordNotes.disabled = state.busy;
  els.discordAnnouncement.disabled = state.busy;
  els.discordAnnounceStart.disabled = state.busy;
  els.discordAnnounceEnd.disabled = state.busy;

  if (!state.installed) {
    els.primaryLabel.textContent = state.busy ? "INSTALLING…" : "INSTALL VTT";
  } else if (state.hosting) {
    els.primaryLabel.textContent = "WORLD ONLINE";
    els.primary.disabled = true;
  } else {
    els.primaryLabel.textContent = "START HOSTING";
  }
  els.stop.classList.toggle("hidden", !state.hosting);
}

function setStatus(text, mode = "") {
  els.statusText.textContent = text;
  els.statusDot.className = `status-dot ${mode}`;
}

function setDiscordStatus(message, kind = "") {
  els.discordStatus.textContent = message;
  if (kind) els.discordStatus.dataset.kind = kind;
  else delete els.discordStatus.dataset.kind;
}


function renderUpdateStatus(result) {
  if (!result?.ok) {
    els.vttUpdateState.innerHTML = `<strong>VTT</strong><small>${result?.message || "Check failed"}</small>`;
    els.launcherUpdateState.innerHTML = `<strong>Launcher</strong><small>Check failed</small>`;
    return;
  }

  const vttText = result.vttCheckError
    ? `Unable to check · ${result.vttCheckError}`
    : result.vtt?.remoteShortSha
      ? (result.vttUpdateAvailable
        ? `${result.vtt.localShortSha || "unknown"} → ${result.vtt.remoteShortSha}`
        : `Current · ${result.vtt.remoteShortSha}`)
      : "Unable to read GitHub";

  const launcherText = result.launcherCheckError
    ? `Unable to check · ${result.launcherCheckError}`
    : result.launcherRelease?.version
      ? (result.launcherUpdateAvailable
        ? `v${result.launcherVersion} → v${result.launcherRelease.version}`
        : `Current · v${result.launcherVersion}`)
      : `No launcher release found · v${result.launcherVersion}`;

  els.vttUpdateState.innerHTML = `<strong>VTT${result.vttUpdateAvailable ? " · UPDATE" : ""}</strong><small>${vttText}</small>`;
  els.launcherUpdateState.innerHTML = `<strong>Launcher${result.launcherUpdateAvailable ? " · UPDATE" : ""}</strong><small>${launcherText}</small>`;
  els.vttUpdateState.classList.toggle("update-available", Boolean(result.vttUpdateAvailable));
  els.launcherUpdateState.classList.toggle("update-available", Boolean(result.launcherUpdateAvailable));

  state.launcherUpdateAvailable = Boolean(result.launcherUpdateAvailable);
  state.latestLauncherVersion = result.launcherRelease?.version || "";
  els.updateLauncher.disabled = state.busy || !state.launcherUpdateAvailable;

  const available = [];
  if (result.vttUpdateAvailable) available.push("VTT");
  if (result.launcherUpdateAvailable) available.push("Launcher");
  const checkErrors = [result.vttCheckError, result.launcherCheckError].filter(Boolean);
  els.updateNotice.classList.toggle("hidden", available.length === 0 && checkErrors.length === 0);
  els.updateNoticeText.textContent = available.length
    ? `${available.join(" + ")} update${available.length > 1 ? "s" : ""} available`
    : checkErrors.length
      ? "Update check incomplete — use Check now to retry"
      : "Everything is current";
}

async function checkUpdates(manual = false) {
  if (manual) {
    els.vttUpdateState.innerHTML = "<strong>VTT</strong><small>Checking GitHub…</small>";
    els.launcherUpdateState.innerHTML = "<strong>Launcher</strong><small>Checking releases…</small>";
  }
  const result = await window.vivid.checkUpdates({
    manual,
    useLocalProject: state.useLocalProject,
    localProjectPath: els.localProjectPath.value.trim(),
  });
  renderUpdateStatus(result);
  return result;
}

els.devMode.checked = state.devMode;
els.devMode.addEventListener("change", () => {
  state.devMode = els.devMode.checked;
  localStorage.setItem("vivid-dev-mode", String(state.devMode));
  els.progressDetail.textContent = state.devMode
    ? "Developer mode enabled: live reload will use ports 5173 and 3001."
    : "Production hosting enabled: the verified build will run on port 3001.";
});


els.localProject.checked = state.useLocalProject;
els.localProjectPath.value = state.localProjectPath;
els.localProject.addEventListener("change", () => {
  state.useLocalProject = els.localProject.checked;
  localStorage.setItem("vivid-local-project", String(state.useLocalProject));
  els.localProjectPath.disabled = !state.useLocalProject || state.busy || state.hosting;
  els.progressDetail.textContent = state.useLocalProject
    ? "Local project enabled: accounts and campaigns will come from that project's server/data folder."
    : "Launcher-managed game copy enabled.";
});
els.localProjectPath.addEventListener("change", () => {
  state.localProjectPath = els.localProjectPath.value.trim();
  localStorage.setItem("vivid-local-project-path", state.localProjectPath);
});

els.discordOpen.addEventListener("click", () => els.discordPanel.classList.remove("hidden"));
els.discordClose.addEventListener("click", () => els.discordPanel.classList.add("hidden"));
els.discordWebhook.addEventListener("input", () => {
  setDiscordStatus("Discord settings changed — save them before your next hosting session.");
});
els.discordNotes.addEventListener("input", () => {
  setDiscordStatus("Discord settings changed — save them before your next hosting session.");
});
els.discordAnnouncement.addEventListener("input", () => {
  setDiscordStatus("Session announcement changed — save it before starting the next session.");
});
els.discordEnabled.addEventListener("change", () => {
  setDiscordStatus(els.discordEnabled.checked
    ? "Discord notifications enabled — save before the next session."
    : "Discord notifications will be disabled after you save.");
});
els.discordAnnounceStart.addEventListener("change", () => {
  setDiscordStatus("Discord settings changed — save them before your next hosting session.");
});
els.discordAnnounceEnd.addEventListener("change", () => {
  setDiscordStatus("Discord settings changed — save them before your next hosting session.");
});

els.saveDiscord.addEventListener("click", async () => {
  setDiscordStatus("Saving Discord settings…", "working");
  const result = await window.vivid.saveDiscordSettings({
    discordWebhookUrl: els.discordWebhook.value,
    discordSessionNotesUrl: els.discordNotes.value,
    discordSessionAnnouncement: els.discordAnnouncement.value,
    discordEnabled: els.discordEnabled.checked,
    discordAnnounceStart: els.discordAnnounceStart.checked,
    discordAnnounceEnd: els.discordAnnounceEnd.checked,
  });
  if (result.ok) {
    setDiscordStatus(
      result.configured
        ? "Discord settings saved. Session lifecycle notifications are ready."
        : "Discord notifications disabled. Your other Discord settings were saved.",
      result.configured ? "sent" : ""
    );
  } else {
    setDiscordStatus(result.message || "Could not save the Discord settings.", "error");
  }
});

els.testDiscord.addEventListener("click", async () => {
  setDiscordStatus("Sending Discord test message…", "working");
  els.testDiscord.disabled = true;
  try {
    const result = await window.vivid.testDiscord(els.discordWebhook.value);
    setDiscordStatus(
      result.ok ? "Test message sent successfully." : (result.message || "Discord test failed."),
      result.ok ? "sent" : "error"
    );
  } finally {
    syncActions();
  }
});

els.primary.addEventListener("click", () => {
  if (!state.installed) window.vivid.install();
  else window.vivid.start({
    devMode: state.devMode,
    useLocalProject: state.useLocalProject,
    localProjectPath: els.localProjectPath.value.trim(),
  });
});
els.stop.addEventListener("click", () => window.vivid.stop());
els.open.addEventListener("click", () => window.vivid.openLocal());
$("copyLink").addEventListener("click", () => {
  if (state.inviteUrl) {
    window.vivid.copy(state.inviteUrl);
    els.progressDetail.textContent = "Invite link copied to clipboard.";
  }
});
$("settingsToggle").addEventListener("click", () => $("toolsPanel").classList.toggle("hidden"));
$("closeToolsPanel").addEventListener("click", () => $("toolsPanel").classList.add("hidden"));
els.updateNotice.addEventListener("click", () => $("toolsPanel").classList.remove("hidden"));
$("developerToolsToggle").addEventListener("click", () => {
  const panel = $("developerToolsPanel");
  const toggle = $("developerToolsToggle");
  const chevron = $("developerToolsChevron");
  const opening = panel.classList.contains("hidden");

  panel.classList.toggle("hidden");
  toggle.setAttribute("aria-expanded", String(opening));
  $("toolsPanel").classList.toggle("developer-open", opening);
  chevron.textContent = opening ? "-" : "+";
});
els.update.addEventListener("click", () => window.vivid.update({
  useLocalProject: state.useLocalProject,
  localProjectPath: els.localProjectPath.value.trim(),
}));
els.checkUpdates.addEventListener("click", () => checkUpdates(true));
els.updateLauncher.addEventListener("click", async () => {
  const result = await window.vivid.installLauncherUpdate();
  if (result?.ok && result?.current) await checkUpdates(true);
});
els.updateChecksEnabled.addEventListener("change", async () => {
  await window.vivid.saveUpdateSettings({ updateChecksEnabled: els.updateChecksEnabled.checked });
});
els.uninstallLauncher.addEventListener("click", async () => {
  const result = await window.vivid.uninstallLauncher();
  if (!result?.ok) {
    els.progressTitle.textContent = "Uninstall could not start";
    els.progressDetail.textContent = result?.message || "Use Windows Settings > Apps > Installed apps to remove Vivid Realms VTT.";
  } else if (result.cancelled) {
    els.progressDetail.textContent = "Launcher uninstall cancelled.";
  } else if (result.launched) {
    els.progressTitle.textContent = "Opening uninstaller";
    els.progressDetail.textContent = "VTT data and backups will be kept.";
  }
});
els.backup.addEventListener("click", () => window.vivid.backup());
els.restore.addEventListener("click", () => window.vivid.restoreBackup());
els.openBackups.addEventListener("click", () => window.vivid.openBackups());
els.openFolder.addEventListener("click", () => window.vivid.openFolder());
$("showLog").addEventListener("click", () => els.logPanel.classList.remove("hidden"));
$("closeLog").addEventListener("click", () => els.logPanel.classList.add("hidden"));
$("minimize").addEventListener("click", () => window.vivid.minimize());
$("close").addEventListener("click", () => window.vivid.close());

window.vivid.onProgress(({ percent, title, detail, indeterminate }) => {
  els.progress.classList.toggle("indeterminate", Boolean(indeterminate));
  if (!indeterminate) els.progress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  els.progressTitle.textContent = title;
  els.progressDetail.textContent = detail || "";
  els.progressPercent.textContent = indeterminate ? "…" : `${Math.round(percent)}%`;
});

window.vivid.onLog((line) => {
  if (!line) return;
  els.logOutput.textContent += `${line}\n`;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
});

window.vivid.onState(({ busy }) => {
  state.busy = busy;
  setStatus(busy ? "Preparing your world…" : state.hosting ? "Online" : "Ready", busy ? "busy" : state.hosting ? "online" : "");
  syncActions();
});

window.vivid.onInstalled(() => {
  state.installed = true;
  setStatus("Installed and ready", "");
  syncActions();
});

window.vivid.onHostReady(({ url }) => {
  state.hosting = true;
  state.inviteUrl = url;
  els.inviteUrl.textContent = url;
  els.invitePanel.classList.remove("hidden");
  setStatus(state.devMode ? (state.useLocalProject ? "Local dev server online" : "Dev server online") : "World online", "online");
  syncActions();
});

window.vivid.onDiscordStatus(({ kind, message }) => {
  setDiscordStatus(message, kind);
});

window.vivid.onUpdateStatus((result) => {
  renderUpdateStatus(result);
});

window.vivid.onHostStopped(() => {
  state.hosting = false;
  state.inviteUrl = "";
  els.invitePanel.classList.add("hidden");
  setStatus("Offline", "");
  syncActions();
});

window.vivid.onError(({ message }) => {
  state.busy = false;
  setStatus("Attention needed", "");
  els.progressTitle.textContent = "Something went wrong";
  els.progressDetail.textContent = message;
  syncActions();
});

(async () => {
  const [status, settings] = await Promise.all([window.vivid.getStatus(), window.vivid.getSettings()]);
  state.installed = status.installed;
  els.discordWebhook.value = settings.discordWebhookUrl || "";
  els.discordNotes.value = settings.discordSessionNotesUrl || "";
  els.discordAnnouncement.value = settings.discordSessionAnnouncement || "";
  els.discordEnabled.checked = settings.discordEnabled === true;
  els.discordAnnounceStart.checked = settings.discordAnnounceStart !== false;
  els.discordAnnounceEnd.checked = settings.discordAnnounceEnd !== false;
  els.updateChecksEnabled.checked = settings.updateChecksEnabled !== false;
  $("launcherVersion").textContent = `Launcher v${status.version}`;
  setDiscordStatus(settings.discordWebhookUrl
    ? (settings.discordEnabled
      ? "Discord configured and enabled. Session lifecycle follows the options above."
      : "Discord is configured but currently switched off.")
    : "Discord notifications are optional and currently disabled.");
  els.progress.style.width = status.installed ? "100%" : "0%";
  els.progressPercent.textContent = status.installed ? "100%" : "0%";
  els.progressTitle.textContent = status.installed ? "Ready to host" : "VTT not installed";
  els.progressDetail.textContent = status.installed
    ? "Launch your world, back it up, or enable Developer mode in the gear menu."
    : "Install Node.js, Cloudflare Tunnel, and the latest VTT build.";
  setStatus(status.installed ? "Installed" : "First-time setup required", "");
  syncActions();
  if (settings.updateChecksEnabled !== false) {
    await checkUpdates(false).catch(() => {});
  }
})();
