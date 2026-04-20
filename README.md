# FlowSFTP

**FlowSFTP** is a **WinSCP-inspired**, **cross-platform** desktop SFTP client with a **simple, uncluttered UI**. It brings the familiar two-pane commander workflow and session-style login to **macOS, Windows, and Linux**—without the visual noise of heavier tools.

**Milestone M1** focuses on SFTP: connect, browse remote and local trees, upload and download (including multi-select transfers aligned with keyboard shortcuts), plus a transfer queue and per-window sessions.

## Screenshot

![FlowSFTP: Login dialog with site list, connection form, and commander window behind](./docs/screenshot.png)

## Stack

- Electron + electron-vite + Vite + Vue 3 + TypeScript + Pinia + Vue Router
- SFTP via `ssh2-sftp-client` (main process only)
- IPC validated with Zod; `window.api` exposed from preload

## Multi-window

Each **File → New window** (or **Ctrl/Cmd+N**) opens another independent commander window. SFTP sessions are scoped to the window that logged in; closing a window drops its connections. The in-app **File** menu (below the OS menu bar) offers the same actions.

## Run

```bash
git clone https://github.com/stackblaze/flowsftp.git
cd flowsftp
npm install
npm run dev
```

## Build

```bash
npm run build
npm run build:mac   # or :win / :linux
```

## Security note (M1)

Host keys are accepted without TOFU UI (see `src/main/sftp/sftp-manager.ts`). Production hardening is planned for milestone M4.

## Docs

- [Keyboard shortcuts](./docs/shortcuts.md) (M1 vs future milestones)
