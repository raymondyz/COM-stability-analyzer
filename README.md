# Stability Analyzer

A static web page that shows how a combat robot rests, which way it rolls from any orientation, how much energy knocks it out of each pose, and how hard it has to be hit to flip.

Everything runs in the browser. Models and mass properties never leave the computer.

- Design and architecture: [docs/SPEC.md](docs/SPEC.md)
- Background math: [docs/combat-bot-stability-notes.md](docs/combat-bot-stability-notes.md)

## Using it

1. Export the whole assembly from SolidWorks as one STL. In the export options, tick "Save all components of an assembly in a single file" and "Do not translate STL output data to positive space".
2. Drop the STL on the page and set its units.
3. In SolidWorks, open Evaluate → Mass Properties → Copy to Clipboard, and paste the result into "Mass properties". You can also enter values by hand.
4. Read the pose list, then use the three views:
   - **Poses** shows the bot at rest.
   - **Basins** shows where each starting orientation rolls. Click the shell to watch a roll.
   - **Hits** shows how hard a hit at each point must be to flip the bot. Pick a starting pose, click the bot to place a hit, then set its direction and strength to see where the bot ends up.

If you don't have a model handy, "Try the sample bot" loads a generated four-wheel wedge.

## Development

```sh
pnpm install
pnpm dev          # dev server
pnpm test         # unit tests (Vitest)
pnpm lint
pnpm build        # type-check and production build into dist/
```

Benchmarks and UI checks:

```sh
pnpm bench                                   # pipeline timings on the sample bot
pnpm bench docs/test_1.STL docs/test_1.txt   # ...or on a real model and its report
pnpm build && pnpm ui-check bench/out        # screenshots at laptop sizes (headless Chromium)
pnpm ui-check bench/out --model docs/test_1.STL --mass docs/test_1.txt --dark
```

`ui-check` needs Playwright's Chromium the first time: `pnpm exec playwright install chromium`.

Test models in `docs/test_*` are gitignored. Tests that use them skip when the files are absent.

## Deployment

Pushes to `main` run [.github/workflows/deploy.yml](.github/workflows/deploy.yml): tests, build, then GitHub Pages. In the repo settings, Settings → Pages → Source must be "GitHub Actions", and the custom domain must stay empty.

The site is served at `raymondz.dev/tools/stability-analyzer/`, where the portfolio's Cloudflare Worker forwards to the Pages address. Asset URLs are relative (`base: './'`), so the same build works at both addresses. The app keeps nothing in local storage, which matters because it shares an origin with the rest of raymondz.dev.
