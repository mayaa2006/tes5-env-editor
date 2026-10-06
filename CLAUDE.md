# Working on this repo

## Owner's standing requests
- **Everything new goes to the front page.** When a piece of work is finished and its checks pass, open a pull request into `main` and merge it, so the repository's front page (README on `main`) always shows the latest. Keep README.md and ROADMAP.md up to date as part of the work.
- **The UI must be easy to use everywhere.** New features need clear labels, tooltips that say what will happen, sensible defaults, empty states that tell you what to do next, and undo. Check new screens at a small window size (1280×800) as well as a large one.

## Checks before merging
- `npm run typecheck`
- `npx vitest run` (unit tests)
- `npm run test:stress -w apps/studio`
- `cd apps/studio && npx playwright test` (browser demo end-to-end tests)
