# Nemesis Desktop

Nemesis is a standalone desktop study agent for macOS, Windows, and Linux. It brings assignments, notes, course planning, research, and agent chat into one local workspace.

The application owns its runtime and data independently:

- macOS and Linux: `~/.nemesis`
- Windows: `%LOCALAPPDATA%\nemesis`
- app identifier: `com.enternemesis.desktop`
- deep links: `nemesis://`

## Beta

Beta builds and release notes are published on [Nemesis Desktop Releases](https://github.com/AxelGalvez11/nemesis-desktop/releases).

Nemesis requires an account and an active subscription. Sign-in happens in the desktop application; subscription management opens the secure browser portal at [app.enternemesis.com/account/billing](https://app.enternemesis.com/account/billing).

Eligible new customers can start one 7-day free trial. A card is required, and the selected monthly plan begins automatically after the trial unless it is canceled first in the billing portal.

The beta subscription unlocks the Nemesis desktop application. Model-provider usage is separate: during beta, users connect their own supported AI provider and are billed according to that provider's terms.

## Development

Use Node.js 22 or newer and Python 3.11.

```bash
npm install
cd apps/desktop
npm run dev
```

Point a development build at a source checkout or isolated runtime home:

```bash
HERMES_DESKTOP_HERMES_ROOT=/path/to/clone npm run dev
NEMESIS_HOME=/tmp/nemesis-test npm run dev
```

Verify the desktop before packaging:

```bash
cd apps/desktop
npm run typecheck
npm run test:desktop:platforms
npm run build
```

The beta is versioned as `0.1.0-beta.1`. Public installers must be signed and, on macOS, notarized before release.

## Repository layout

- `apps/desktop` — Electron desktop application
- `apps/bootstrap-installer` — standalone native setup and update handoff
- `hermes_cli` — embedded local agent runtime
- `scripts` — platform installers and release tooling

Some internal module names and environment variables remain compatibility interfaces for the embedded runtime. They are implementation details and do not share application data with a separate installation.

## License and attribution

Nemesis includes modified software originally developed by Nous Research and distributed under the MIT License. The original copyright and full license text are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Nemesis-specific branding, product copy, and artwork are not granted by the upstream software license.
