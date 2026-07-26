# local-ai-code-review-action

![Binary downloads](https://img.shields.io/github/downloads/runbot-hq/local-ai-cli/total?label=binary%20downloads&color=purple&logo=github)

A GitHub Action that reviews pull request diffs using a local [Ollama](https://ollama.com) model on a self-hosted runner. No cloud API, no API keys, no cost per review.

Powered by [`local-ai-cli`](https://github.com/runbot-hq/local-ai-cli). Works with any model Ollama supports — recommended: `qwen3.5:9b` or `codegeex4:9b` on Apple Silicon (16GB RAM).

> Part of the [RunBot](https://github.com/runbot-hq/run-bot) ecosystem.

## Usage

```yaml
# .github/workflows/ai-code-review.yml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: [self-hosted, macos-m1]
    # Fork guard: prevents external fork PRs from running arbitrary code on
    # your self-hosted runner. Without this, any GitHub user can open a fork PR
    # and execute code on your machine.
    if: |
      github.event_name != 'pull_request' ||
      github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      pull-requests: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - uses: runbot-hq/local-ai-code-review-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          model: qwen3.5:9b
          temperature: '0.2'
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `model` | `qwen3.5:9b` | Any model pulled via `ollama pull` |
| `base_url` | `http://localhost:11434` | Ollama base URL |
| `temperature` | `0.2` | Sampling temperature (0.0–1.0) |
| `maximum_response_tokens` | `4096` / `8192` | Max tokens to generate. Automatically set by review tier: `4096` for shallow (< 150 reviewable lines), `8192` for deep. Override by setting this input explicitly. |
| `timeout_seconds` | `600` | URLRequest timeout in seconds. Increase for large or slow models. |
| `prompt_extra` | *(none)* | Extra instructions appended to the review prompt (max 300 chars) |
| `replace_existing_comment` | `false` | When `false` (default), each review run appends a new comment — full review history is preserved. When `true`, the previous bot comment is deleted before posting a new one (single living comment per PR). |
| `skip_review_label` | `[skip ai review]` | If this string is found in the PR title, PR body, or head commit message, the review is skipped entirely. See [Skipping a review](#skipping-a-review). |
| `debug` | `false` | Enable debug logging |

## Outputs

| Output | Description |
|---|---|
| `review_body` | The full review comment posted to the PR |

## Skipping a review

Add `[skip ai review]` anywhere in your **PR title**, **PR body**, or **commit message** to skip the review for that trigger.

**Skip via commit message** — useful for fixup pushes that don't need a review:
```
git commit -m "fix typo [skip ai review]"
```

**Skip via PR title** — skips every subsequent push to the PR:
```
chore: update lockfile [skip ai review]
```

**Skip via PR body** — same effect, keeps the title clean:
> Add `[skip ai review]` anywhere in the PR description.

The flag is case-insensitive. The check fires before any binary download or model call; the only cost on a skipped run is one lightweight `repos.getCommit` API call to read the head commit message.

To use a custom flag instead of the default, set the `skip_review_label` input in your workflow:

```yaml
- uses: runbot-hq/local-ai-code-review-action@v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    skip_review_label: '[no review]'
```

## Requirements

- A self-hosted macOS runner (Apple Silicon recommended)
- [Ollama](https://ollama.com) installed and running as a service (`brew services start ollama`)
- Model pre-pulled: `ollama pull qwen3.5:9b` or `ollama pull codegeex4:9b`

## Recommended models (16GB RAM)

| Model | Best for |
|---|---|
| `qwen3.5:9b` | General coding + chat reviews |
| `codegeex4:9b` | Dedicated code review, 89K context window |
| `qwen3.5:4b` | Fastest, lowest RAM usage |

## Review signature

Every review comment ends with:

> 🤖 AI code review by [github.com/runbot-hq/run-bot](https://github.com/runbot-hq/run-bot)

## Contributing

`dist/index.js` is the compiled, bundled entry point the action actually executes — it is not hand-edited. The source lives in `src/`. On every push to `main`, the [`build.yml`](.github/workflows/build.yml) workflow runs `npm run build` (via [ncc](https://github.com/vercel/ncc)) and commits the updated `dist/index.js` automatically. You do not need to build locally before merging a PR.

## Related

- [`local-ai-cli`](https://github.com/runbot-hq/local-ai-cli) — the CLI sidecar this action uses
- [`afm-release-notes-action`](https://github.com/runbot-hq/afm-release-notes-action) — sister action using Apple FoundationModels
- [RunBot](https://github.com/runbot-hq/run-bot) — macOS menu bar app for GitHub Actions
