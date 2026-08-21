VIVID REALMS ELECTRON LAUNCHER — MAP EDITION

This replaces the frozen Inno Setup progress screen with a real game-style launcher.

FEATURES
- Full cinematic fantasy launcher interface
- Frameless custom window
- First-time install and update flow
- Real byte-based GitHub download progress
- Downloaded amount and download speed
- Stage progress for extraction, dependencies, build, and verification
- Automatic Node.js LTS and Cloudflare Tunnel setup through winget
- Preserves server/data during updates
- Start/stop hosting without visible CMD windows
- Detects and displays the trycloudflare.com invite URL
- Copy Link, Open Local, Update, and Open Game Folder controls
- Windows taskbar progress
- Standard NSIS installer generated through electron-builder
- Uninstall keeps campaign data by default

PREVIEWING IT
1. Extract this folder.
2. Double-click PREVIEW-LAUNCHER.bat.
3. The first run downloads Electron dependencies.
4. The launcher opens without installing it.

BUILDING THE SETUP EXE
1. Install Node.js LTS.
2. Double-click BUILD-LAUNCHER.bat.
3. The finished installer appears in:
   dist\Vivid-Realms-VTT-Setup-0.1.0.exe

CURRENT REPOSITORY
https://github.com/browerg/dnd-vtt
Branch: rwby-theme

IMPORTANT
- The installer is unsigned, so Windows may show Unknown Publisher or SmartScreen.
- The first VTT installation may take several minutes because npm dependencies are installed.
- Stage-based tasks such as npm install cannot report exact byte totals, so the launcher uses an animated indeterminate bar during those stages.
- The GitHub VTT archive itself uses real byte progress when Content-Length is available.
- Test the install on your own PC before sending it to another DM.

MAP EDITION
- Uses the approved RWBY World of Remnant map as the launcher background image.

V0.1.1 WINDOWS FIX
- Fixed the `spawn EINVAL` error when launching npm.cmd.
- Windows .cmd and .bat commands now run through cmd.exe.
- The launcher refreshes PATH after winget installs Node.js or Cloudflare Tunnel.
- npm and cloudflared are resolved to their installed paths before use.

V0.1.2 NPM PATH FIX
- Fixed literal escaped quotes around C:\Program Files\nodejs\npm.cmd.
- Windows .cmd/.bat files now use Node's shell handling so paths with spaces work correctly.

V0.1.3 CMD QUOTING FIX
- Removed shell:true to eliminate the DEP0190 warning.
- Added correct cmd.exe outer quoting for npm.cmd paths inside Program Files.
- Arguments are individually quoted before being passed to cmd.exe.

V0.1.4 NPM EXECUTION FIX
- Stops launching npm.cmd through cmd.exe entirely.
- Runs npm through node.exe + npm-cli.js instead.
- Avoids Windows quoting, Program Files, and "network path was not found" errors.


V0.1.7 DEVELOPER MODE
Open the gear menu and check Developer mode before Start Hosting to run Vite live reload on port 5173 plus the server on 3001. Leave it unchecked for normal production hosting through port 3001. The choice is remembered.


VERSION 0.1.8 — LOCAL DEVELOPMENT PROJECT MODE
Developer mode alone uses the launcher's private installed copy. To use your existing local accounts and campaigns, also check "Use local development project" and confirm C:\Users\pirat\dnd-vtt-rwby.


V0.1.9 PORT SAFETY
- Automatically closes stale listeners on ports 3001 and 5173 before hosting.
- Vite uses strict port 5173 and will no longer silently move to 5174.
- Cloudflare starts only after the exact selected origin responds.
