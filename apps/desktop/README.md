# Nemesis Desktop — Beta

Nemesis is a standalone desktop study agent for macOS, Windows, and Linux. It brings assignments, notes, flashcards, course planning, research, and agent chat into one native workspace.

The beta includes its local AI runtime. Users install and launch Nemesis as its own application; no separate agent installation or retired web app is required.

## Beta installation

Download signed beta builds and release notes from [Nemesis Desktop Releases](https://github.com/AxelGalvez11/nemesis-desktop/releases).

Nemesis stores its local runtime and user data in its own application directory:

- macOS and Linux: `~/.nemesis`
- Windows: `%LOCALAPPDATA%\nemesis`

The embedded runtime continues to receive this location through `HERMES_HOME` for compatibility. Development builds may point at another home explicitly; packaged Nemesis builds ignore a global `HERMES_HOME` so they cannot adopt another application's data.

The primary deep-link protocol is `nemesis://`. A legacy protocol remains accepted internally during the beta transition.

## Development

Install workspace dependencies from the repository root, then start Electron:

```bash
npm install
cd apps/desktop
npm run dev
```

Point the app at a source checkout or use a throwaway runtime home:

```bash
HERMES_DESKTOP_HERMES_ROOT=/path/to/clone npm run dev
HERMES_HOME=/tmp/nemesis-test npm run dev
npm run dev:fake-boot
```

### Build packages

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
npm run pack
```

These commands produce direct Electron packages for development and platform testing. Public beta distribution uses the native Setup handoff so the private runtime and updater helper are installed together:

```bash
cd ../bootstrap-installer
npm run tauri:build
```

Artifacts use the Nemesis name and the application identifier `com.enternemesis.desktop`. Release publishing targets [AxelGalvez11/nemesis-desktop](https://github.com/AxelGalvez11/nemesis-desktop).

### Verification

```bash
npm run typecheck
npm run lint
npm run test:desktop:platforms
npm run test:ui
```

## Runtime architecture

The packaged Electron shell launches Nemesis' local backend and passes its isolated data directory through the runtime compatibility API. Some internal command names, environment variables, IPC channels, and API headers retain upstream compatibility identifiers; these are implementation details, not the product identity.

Boot logs are written to `HERMES_HOME/logs/desktop.log`, which is normally `~/.nemesis/logs/desktop.log` or `%LOCALAPPDATA%\nemesis\logs\desktop.log`.

To reset a beta runtime:

```bash
# macOS / Linux
rm -rf "$HOME/.nemesis"
```

```powershell
# Windows
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\nemesis"
```

On macOS, reset microphone permission with:

```bash
tccutil reset Microphone com.enternemesis.desktop
```

## Accounts and subscriptions

Nemesis signs users in inside the desktop app. Account and subscription management opens the secure browser portal at [app.enternemesis.com/account](https://app.enternemesis.com/account).

Eligible new customers can start one 7-day free trial. A card is required, and the selected monthly plan begins automatically after the trial unless it is canceled first in the billing portal.

## Licensing and attribution

Nemesis includes software originally developed by Nous Research under the MIT License. The original copyright and license text are preserved in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
