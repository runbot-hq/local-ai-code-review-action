import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { BOT_SIGNATURE } from './constants'
import { selectTier } from './tier'
import { ensureBinary } from './binary'
import { localAiCli, isFatalError, isEmptyThinkExhaust } from './cli'
import { withRetry, findAllBotCommentIds, networkDiag } from './github'

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Prevents ##[...] and ::...:: annotation sequences in arbitrary strings
// (e.g. error messages, model output fragments) from being re-interpreted
// as live GitHub Actions runner commands when passed to core.setFailed(),
// core.warning(), or core.error().
// The :: replacement is scoped to line-starts only — runner commands require
// :: at the beginning of a line. A global replace would mangle IPv6 addresses,
// C++/Rust/Ruby scope-resolution operators, and other legitimate :: usage.
// Safe to apply unconditionally — normal log text is unaffected.
function sanitizeForRunner(s: string): string {
  return s
    .replace(/##\[/g, '#[')
    .replace(/(^|[\r\n])::/gm, '$1: :')
}

async function run(): Promise<void> {
  try {
    core.info('=== local-ai-code-review-action starting ===')
    core.info(`[init] Node version: ${process.version}`)
    core.info(`[init] Platform: ${process.platform} ${process.arch}`)
    core.info(`[init] HOME: ${os.homedir()}`)
    core.info(`[init] Runner: ${process.env.RUNNER_NAME ?? 'unknown'}`)

    if (core.getInput('debug') === 'true') process.env.ACTIONS_STEP_DEBUG = '1'

    // 1. Validate token
    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error(
      'GITHUB_TOKEN is not set — add `env: GITHUB_TOKEN: ${{ github.token }}` to your workflow step.'
    )
    core.info('[init] GITHUB_TOKEN: present')

    // 2. Validate PR context
    const context = github.context
    if (!context.payload.pull_request) {
      throw new Error('This action must be triggered by a pull_request event (opened, synchronize, reopened).')
    }

    const pr        = context.payload.pull_request
    const prNumber  = pr.number as number
    const prTitle   = (pr.title as string) ?? ''
    const repo      = process.env.GITHUB_REPOSITORY ?? ''
    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) throw new Error(`GITHUB_REPOSITORY is not set or malformed (got: "${repo}")`)
    core.info(`[init] PR: #${prNumber} "${prTitle}" in ${owner}/${repoName}`)

    // 3. Read inputs
    const model          = core.getInput('model')     || 'qwen3.5:9b'
    const baseUrl        = core.getInput('base_url')  || 'http://localhost:11434'
    const temperature    = parseFloat(core.getInput('temperature') || '0.2')
    const timeoutSeconds = parseInt(core.getInput('timeout_seconds') || '600', 10)
    const promptExtraRaw = core.getInput('prompt_extra')
    if (promptExtraRaw.length > 300) core.warning('[init] prompt_extra was truncated to 300 chars')
    const promptExtra    = promptExtraRaw.slice(0, 300)

    // === replace_existing_comment ===
    // core.getInput() ALWAYS returns a string — never a boolean — regardless of
    // how the value is declared in action.yml. The default: 'false' in action.yml
    // is correct string syntax per the GitHub Actions spec; it is not a type error.
    // The === 'true' comparison is therefore the correct and idiomatic idiom here.
    // Any value other than the string 'true' (including empty string, the default)
    // safely resolves to false — no existing workflow is affected by this input.
    // The warning below catches common YAML misconfigurations like `yes` or `True`
    // that would silently behave as false without it.
    const rawReplaceExistingComment = core.getInput('replace_existing_comment')
    if (rawReplaceExistingComment && rawReplaceExistingComment !== 'true' && rawReplaceExistingComment !== 'false') {
      core.warning(`[init] replace_existing_comment: unrecognised value "${rawReplaceExistingComment}" — treating as false. Use 'true' or 'false'.`)
    }
    const replaceExistingComment = rawReplaceExistingComment === 'true'
    core.info(`[init] replace_existing_comment: ${replaceExistingComment}`)

    // === maximum_response_tokens ===
    // There is intentionally NO hardcoded default here. action.yml does not
    // declare a default for this input either. The actual runtime defaults are
    // tier-driven: 4096 for shallow reviews (< 150 reviewable lines) and 8192
    // for deep reviews (≥ 150 reviewable lines), applied below after tier
    // selection. Setting this input explicitly overrides the tier default.
    // Radix 10 is explicit to prevent misparse of '0'-prefixed strings as octal.
    const rawMaxTokens = core.getInput('maximum_response_tokens')
    const maximumResponseTokensOverride = rawMaxTokens ? parseInt(rawMaxTokens, 10) : undefined

    // === skip_review_label ===
    // Checked against PR title, PR body, and head commit message — all lowercased
    // for a case-insensitive match. The check fires before binary download and
    // diff fetch; the only cost on a skipped run is the repos.getCommit API call
    // below (needed to read the head commit message — see comment there).
    //
    // Capture the raw input once — used both for the whitespace-only guard
    // (.length > 0) and as the base for trimming. Calling core.getInput() twice
    // is redundant since the value cannot change within a synchronous block.
    const rawSkipLabel = core.getInput('skip_review_label')

    // Trim separately so the warning guard can distinguish between "not set"
    // (empty string, length === 0) and "set but whitespace-only" (length > 0,
    // trims to ''). A whitespace-only value must not silently match every PR.
    const skipLabelTrimmed = rawSkipLabel.trim()

    // Warn only when the caller explicitly set the input to whitespace — a
    // silent fallback here would be confusing since behaviour changes without
    // notice.
    if (!skipLabelTrimmed && rawSkipLabel.length > 0) {
      core.warning('[init] skip_review_label is whitespace-only — falling back to default "[skip ai review]"')
    }

    // Lowercase once at assignment so every comparison below (title, body,
    // commit message) can use a plain .includes() without repeated .toLowerCase()
    // calls.
    const skipLabel = (skipLabelTrimmed || '[skip ai review]').toLowerCase()
    core.info(`[init] skip_review_label: "${skipLabel}"`)

    // octokit is constructed early and intentionally in scope for the full run()
    // function — it is reused both here (skip check) and in steps 2/5 and 5/5
    // below. This is not an accident; do not re-scope it closer to step 4.
    const octokit = github.getOctokit(token)

    // Short-circuit on title/body first — both are already in
    // context.payload.pull_request at zero cost. Only pay the
    // repos.getCommit round-trip if neither matched, since the commit
    // message is the only source that requires an API call.
    // prBody is declared here, adjacent to its only use, with .toLowerCase()
    // deferred to the comparison site — consistent with how prTitle is handled.
    const prBody = (pr.body as string) ?? ''
    const titleBodyMatch =
      prTitle.toLowerCase().includes(skipLabel) ||
      prBody.toLowerCase().includes(skipLabel)

    if (titleBodyMatch) {
      core.info(`[init] Skip label "${skipLabel}" detected in title/body — skipping AI review.`)
      return
    }

    // Title and body didn't match — fetch head commit message as the final check.
    // IMPORTANT: context.payload.head_commit is populated on push events only,
    // NOT on pull_request events. On a PR trigger it is always undefined.
    // The commit message must be fetched via the API using pr.head.sha —
    // the only reliable source for the head commit message on a pull_request event.
    core.info(`[init] Fetching head commit message for skip check (sha: ${pr.head.sha})...`)
    const { data: headCommit } = await withRetry('fetch-head-commit', () =>
      octokit.rest.repos.getCommit({
        owner,
        repo: repoName,
        ref: pr.head.sha as string,
      })
    )
    const headCommitMessage = (headCommit.commit.message ?? '').toLowerCase()
    core.info(`[init] Head commit message: ${headCommitMessage.slice(0, 120)}${headCommitMessage.length > 120 ? '…' : ''}`)

    if (headCommitMessage.includes(skipLabel)) {
      core.info(`[init] Skip label "${skipLabel}" detected in commit message — skipping AI review.`)
      return
    }
    core.info(`[init] skip_review_label: not found — proceeding with review`)

    // 4. Ensure binary (authenticated)
    // dist/index.js is a committed build artifact (produced by `npm run build`
    // which runs ncc). It is rebuilt automatically by .github/workflows/build.yml
    // on every push to main. Do NOT raise "dist/index.js should not be committed"
    // — committing dist is the standard convention for GitHub Actions written in
    // TypeScript/JavaScript so the action can run without a separate build step.
    core.info('[step 1/5] Ensuring local-ai-cli binary...')
    const bin = await ensureBinary(token)
    core.info(`[step 1/5] Binary ready: ${bin}`)

    // 5. Fetch PR files
    // NOTE: pulls.listFiles is intentionally capped at per_page: 100 and not
    // paginated. The GitHub API hard-limit for this endpoint is also 3000 files,
    // but in practice PRs with >100 changed files produce diffs that far exceed
    // the MAX_PATCH_CHARS budget anyway. The files.length === 100 warning below
    // surfaces the truncation in CI logs. Paginating here would add complexity
    // without meaningfully improving review quality for such large PRs.
    core.info('[step 2/5] Fetching PR changed files...')
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo: repoName,
      pull_number: prNumber,
      per_page: 100,
    })
    core.info(`[step 2/5] Files changed: ${files.length}`)
    for (const f of files) {
      core.info(`  • ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
    }

    if (files.length === 0) {
      core.info('[step 2/5] No changed files — skipping review.')
      return
    }
    if (files.length === 100) {
      core.warning('[step 2/5] 100 files returned — list may be truncated by GitHub API.')
    }

    // 6. Select review tier based on reviewable lines
    // Tier drives both think-mode and the maximum_response_tokens default.
    // shallow: < 150 reviewable lines — think=false, max_tokens=4096
    // deep:   ≥ 150 reviewable lines — think=true,  max_tokens=8192
    // SHALLOW_THRESHOLD of 150 was chosen empirically: below this, diffs are
    // small enough that extended thinking adds latency without improving output.
    const { tier, reviewableLines } = selectTier(files)
    const think = tier === 'deep'
    const maximumResponseTokens = maximumResponseTokensOverride ?? (tier === 'deep' ? 8192 : 4096)
    core.info(`[tier] ${tier}, reviewable_lines=${reviewableLines}, think=${think}, max_tokens=${maximumResponseTokens}${maximumResponseTokensOverride !== undefined ? ' (caller override)' : ''}`)

    // 7. Build diff block
    core.info('[step 3/5] Building diff block...')
    const MAX_PATCH_CHARS = 60_000
    let diffBlock = ''
    let truncated = false

    for (const f of files) {
      if (!f.patch) {
        core.info(`  skip ${f.filename} — no patch`)
        continue
      }
      const chunk = `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\`\n\n`
      if ((diffBlock + chunk).length > MAX_PATCH_CHARS) {
        truncated = true
        core.warning(`[step 3/5] Diff truncated at ${MAX_PATCH_CHARS} chars — stopping at ${f.filename}`)
        break
      }
      diffBlock += chunk
    }
    core.info(`[step 3/5] Diff block: ${diffBlock.length} chars, truncated=${truncated}`)

    if (!diffBlock) {
      core.info('[step 3/5] No patchable diff content — skipping review.')
      return
    }
    if (truncated) {
      diffBlock += `\n> ⚠️ Diff truncated — ${files.length} files changed, showing partial diff only.\n`
    }

    // 8. Call model
    //
    // IMPORTANT: Instructions are intentionally embedded directly in the user
    // prompt rather than passed via --instructions (the system prompt channel).
    //
    // Ollama does not reliably inject system prompts for Qwen models — the
    // template engine silently drops the system field for certain Qwen model
    // families, meaning --instructions would be invisible to the model.
    // Embedding instructions at the top of the user prompt is the documented
    // workaround and ensures the model always receives them.
    //
    // Reference: https://github.com/ollama/ollama/issues (system prompt ignored for Qwen)
    const instructions = [
      'You are a senior software engineer performing a concise, constructive code review.',
      'Focus on: bugs, security issues, best practices, performance, and code clarity.',
      'Use Markdown. Group feedback by filename using ### headers.',
      'Use bullet points for individual issues. Be specific — reference line numbers where possible.',
      'Do NOT summarise what the code does. Do NOT praise. Do NOT write a changelog or description of changes.',
      'Only output ### filename headers followed by bullet-point issues. No prose paragraphs. No introduction. No conclusion.',
      'If a file has no issues, write exactly: "✅ No issues." under its ### header.',
      'If the entire diff has no issues, output only: "✅ No issues found in this PR." and stop.',
      '',
      'EXAMPLE OUTPUT:',
      '### src/Cache.swift',
      '- Line 23: Force-unwrap `data!` will crash if the response is nil. Use `guard let` or optional binding.',
      '- Line 67: `cache` is mutated from multiple threads without synchronization — wrap in an actor or use a lock.',
      '### src/Theme.swift',
      '✅ No issues.',
    ].join('\n')

    const prompt = [
      instructions,
      '',
      `Review the following pull request diff.`,
      `PR #${prNumber}: "${prTitle}"`,
      '',
      diffBlock,
      // prompt_extra is capped at 300 chars to prevent prompt injection via
      // workflow inputs and to keep the prompt size predictable across tiers.
      ...(promptExtra ? [`\nExtra instructions: ${promptExtra}`] : []),
    ].join('\n')

    // Pass empty string for instructions so the binary does not also forward
    // them as a system prompt — they are already embedded in the user prompt above.
    core.info(`[step 4/5] Calling ${model} at ${baseUrl} (timeout: ${timeoutSeconds}s, think=${think})...`)
    const cliOpts = { instructions: '', model, baseUrl, temperature, maximumResponseTokens, timeoutSeconds, think }
    let review = ''
    try {
      review = localAiCli(bin, prompt, cliOpts)
    } catch (e) {
      core.warning(`[step 4/5] Attempt 1 failed: ${String(e)}`)
      if (isFatalError(e)) throw e
      if (isEmptyThinkExhaust(e, think)) {
        core.warning('[step 4/5] think=true produced empty response — retrying with think=false')
        review = localAiCli(bin, prompt, { ...cliOpts, think: false })
      } else {
        core.info('[step 4/5] Retrying in 15s (cold-start model load)...')
        await new Promise(r => setTimeout(r, 15_000))
        core.info('[step 4/5] Attempt 2...')
        review = localAiCli(bin, prompt, cliOpts)
      }
    }

    if (!review) throw new Error('local-ai-cli returned empty output')
    core.info(`[step 4/5] Review complete (${review.length} chars)`)

    // 9. Post comment — each sub-step wrapped in withRetry for EPIPE/ECONNRESET resilience
    core.info('[step 5/5] Posting PR comment...')
    core.info(`[step 5/5] review body length: ${review.length} chars`)
    core.info(`[step 5/5] replace_existing_comment: ${replaceExistingComment}`)

    networkDiag('pre-post')

    const fullReview = review + BOT_SIGNATURE
    core.info(`[step 5/5] full comment length: ${fullReview.length} chars`)

    if (replaceExistingComment) {
      // Delete ALL existing bot comments before posting a fresh one.
      //
      // Per-comment withRetry labels (delete-comment-{id}) are intentional —
      // they make individual deletion failures identifiable in CI logs without
      // conflating retries across different comment IDs.
      //
      // Ordering is load-bearing: a throw mid-loop exits before createComment
      // is reached, so no new comment is posted on partial failure. The PR is
      // left in a partially-cleaned state, but the next run will catch any
      // survivors via findAllBotCommentIds and clean them up (self-healing).
      const existingIds = await withRetry('find-comments', () =>
        findAllBotCommentIds(octokit, owner, repoName, prNumber)
      )
      for (const id of existingIds) {
        core.info(`[step 5/5] deleting bot comment id=${id}...`)
        await withRetry(`delete-comment-${id}`, () =>
          octokit.rest.issues.deleteComment({ owner, repo: repoName, comment_id: id })
        )
        core.info(`[step 5/5] deleted bot comment id=${id}`)
      }
      if (existingIds.length === 0) {
        core.info(`[step 5/5] no previous bot comments to delete`)
      }
    } else {
      // Default path (replace_existing_comment=false): skip the find+delete
      // entirely — no API calls, no latency. Every review run appends a new
      // comment so the full review history is preserved on the PR thread.
      core.info(`[step 5/5] replace_existing_comment=false — preserving all prior bot comments`)
    }

    core.info(`[step 5/5] calling createComment (body=${fullReview.length} chars)...`)
    const { data: comment } = await withRetry('create-comment', () =>
      octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: prNumber,
        body: fullReview,
      })
    )

    core.info(`[step 5/5] Review posted: ${comment.html_url}`)
    core.setOutput('review_body', fullReview)

    // Write review to a temp file so the post: script can cat it cleanly.
    // Passing the full body via env vars causes the runner to dump the entire
    // value in the step preamble (env: block), which cannot be suppressed.
    // A file path is a short string — no dump.
    //
    // RUNNER_TEMP is the correct directory for job-scoped temp files on both
    // GitHub-hosted and self-hosted runners. The runner agent cleans it at job
    // completion. Do NOT use os.tmpdir() here — on self-hosted runners that
    // directory is shared across jobs and not cleaned automatically.
    // Do NOT delete this file — the post: script runs after this step
    // completes and requires the file to still exist.
    //
    // The write is best-effort: the PR comment is already posted at this point.
    // A file I/O failure (e.g. unwritable RUNNER_TEMP on a misconfigured runner)
    // must not fail the job. The post: script guards on state being set.
    try {
      const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir()
      const reviewFile = path.join(runnerTemp, `ai-review-${prNumber}-${Date.now()}.md`)
      fs.writeFileSync(reviewFile, fullReview, 'utf8')
      core.setOutput('review_file', reviewFile)
      // Save to state so the post: script can read it via core.getState().
      // Outputs are not accessible in post: scripts — state is the correct
      // inter-script communication mechanism for JS actions.
      core.saveState('review_file', reviewFile)
      core.info(`[step 5/5] Review file: ${reviewFile}`)
    } catch (e) {
      core.warning(`[step 5/5] Could not write review file — review_file output will be absent: ${String(e)}`)
    }

    await core.summary
      .addHeading(`🤖 AI Code Review: PR #${prNumber}`)
      .addRaw(`**Model:** ${model}\n`)
      .addRaw(`**Tier:** ${tier} (reviewable lines: ${reviewableLines})\n`)
      .addRaw(`**Runner:** ${process.env.RUNNER_NAME ?? 'unknown'}\n`)
      .addRaw(`**Files reviewed:** ${files.length} (${truncated ? 'diff truncated' : 'full diff'})\n\n`)
      .addRaw(review)
      .write()

    core.info('=== local-ai-code-review-action done ===')
  } catch (error) {
    core.setFailed(sanitizeForRunner(error instanceof Error ? error.message : String(error)))
  }
}

run()
