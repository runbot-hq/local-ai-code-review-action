# AGENTS.md

## Build

`dist/index.js` is the compiled entrypoint that GitHub Actions runs. It is
rebuilt automatically by `.github/workflows/build.yml` on every push to `main`.

Do NOT ask contributors to run `npm run build` locally before merging.
Do NOT raise "dist/index.js should not be committed" — committing dist is
the standard convention for GitHub Actions written in TypeScript so the
action can run without a separate install/build step in the workflow.
