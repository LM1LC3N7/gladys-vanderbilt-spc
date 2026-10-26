# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
It started from the official JavaScript template. It talks to a Vanderbilt
SPC alarm panel through the SPC Web Gateway of Lundix (REST + websocket);
runtime dependencies: the SDK and `ws`.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/commands.test.js         # one file
node --test --test-name-pattern "unset"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png, plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   the SDK handlers, shared with the tests
src/app.js                        SpcApp: lifecycle, pace, events, commands, guards
src/spc/client.js                 the REST API of the gateway (pyspcwebgw __init__.py)
src/spc/http.js                   one HTTP request, its own connection, bounded
src/spc/auth.js                   Digest / Basic answer to a 401 challenge
src/spc/events.js                 the websocket /ws/spc (`ws`)
src/spc/parse.js                  answers and events, checked field by field
src/spc/errors.js                 error codes
src/devices.js                    model -> Gladys devices and states (pure)
src/publisher.js                  states under the Gladys rate limits
src/store.js                      /data: panel serial, last read, refusal marker, guards
src/config.js                     DEFAULTS (mirror the manifest defaults) + normalization
src/constants.js, src/i18n.js     codes, limits, timings; French and English texts
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, the SDK's fake Gladys + test/helpers/fakeGateway.js
scripts/cover.mjs                 the cover, plain Node
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

Safety rules of this integration (see TODO.md "Decisions"): setting an area
is protective (no option, no read before, not behind a read, a pause, a
refusal kept or an unset; tried again within its time while not delivered);
a set the gateway accepted is never sent again (an occupant may have
cancelled it); one never delivered only on a fresh read showing nothing
moved, within 2 minutes; the credentials go in Basic only with its option and
never after Digest worked;
unsetting is off by default (option read again right before the write),
decided on a fresh read, needs the panel identity read in the session;
commands are push buttons, never switches; a command that may have left is
never reported "not sent"; refused credentials are never tried again by
themselves; the credentials are sent only in answer to a challenge of the
gateway and never logged.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log the password, an Authorization header or a
  user name of the panel.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set once, see TODO.md). `test/manifest.test.js` checks
  they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. A secret
  field is "kept by Gladys in its database, never shown again", never said
  to be ciphered (`test/encoding.test.js` checks the words). The docs list
  exactly when a set is refused: no "always" nor "never" there.
- **Units**: none here; only `DEVICE_FEATURE_UNITS_BY_CATEGORY` of the core
  if one is ever added.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (the real transports are tested
  on loopback only).
