import * as core from '@actions/core'
import * as github from '@actions/github'
import { spawnSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calls local-ai-cli-bin via spawnSync with an explicit argv array.
 *
 * spawnSync is used instead of execSync deliberately — it passes args
 * directly to the OS without invoking a shell, eliminating any risk of
 * shell metacharacter interpretation in prompt content.
 * Do NOT refactor to execSync with a shell string.
 *
 * Flag names mirror local-ai-cli exactly:
 *   --prompt                   → user message
 *   --instructions             → system prompt
 *   --model                    → Ollama model name
 *   --temperature              → sampling temperature
 *   --maximum-response-tokens  → num_predict
 *   --base-url                 → Ollama base URL
 *   --timeout                  → URLRequest timeout in seconds (default 300)
 */
function localAiCli(bin: string, prompt: string, options?: {
  instructions?: string
  model?: string
  baseUrl?: string
  temperature?: number
  maximumResponseTokens?: number
  timeoutSeconds?: number
}): string {
  const args: string[] = ['--prompt', prompt]

  if (options?.instructions) args.push('--instructions', options.instructions)
  if (options?.model)        args.push('--model', options.model)
  if (options?.baseUrl)      args.push('--base-url', options.baseUrl)
  if (options?.temperature !== undefined) args.push('--temperature', String(options.temperature))
  if (options?.maximumResponseTokens !== undefined) args.push('--maximum-response-tokens', String(options.maximumResponseTokens))
  // Always pass --timeout explicitly — URLSession.shared default is 60s which is
  // insufficient for large model cold loads (qwen3.5:9b). Do NOT remove this.
  args.push('--timeout', String(options?.timeoutSeconds ?? 300))

  if (core.isDebug()) {
    core.debug(`[local-ai] spawnSync: ${bin} ${args.map(a => JSON.stringify(a)).join(' ')}`)
  }

  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    // 360s — must exceed the --timeout passed to the binary (300s) plus
    // buffer for process startup and response marshalling.
    // Do NOT lower below 300s.
    timeout: 360_000,
    // 10MB buffer — large model responses (4096 tokens of markdown) can exceed
    // Node's default 1MB maxBuffer, causing a silent ENOBUFS truncation.
    // Do NOT lower this value.
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`local-ai-cli exited ${result.status}: ${result.stderr?.trim()}`)
  }

  return result.stdout.trim()
}

/**
 * Returns true if the error is fatal and a retry cannot recover from it.
 * These map to hard exit(1) paths in local-ai-cli main.swift, or to
 * Ollama HTTP errors that will never resolve on retry.
 *
 * HTTP 404 = model not found — retrying after 15s will not help.
 * invalid --base-url = bad config — will never resolve.
 * eacces / enoent = binary permissions or missing file — will never resolve.
 */
function isFatalError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return (
    msg.includes('invalid --base-url') ||
    msg.includes('http 404') ||
    msg.includes('eacces') ||
    msg.includes('enoent')
  )
}

/**
 * Finds an existing bot review comment on the PR (identified by the signature).
 * Paginates through all comments — PRs with >100 comments would miss the old
 * bot comment without pagination, causing duplicate reviews to accumulate.
 * Returns the comment ID if found, otherwise undefined.
 */
async function findExistingBotComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number | undefined> {
  let page = 1
  while (true) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      page,
    })
    const bot = comments.find(c => c.body?.includes('AI code review by [github.com/runbot-hq/run-bot]'))
    if (bot) return bot.id
    if (comments.length < 100) return undefined
    page++
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  try {
    if (core.getInput('debug') === 'true') process.env.ACTIONS_STEP_DEBUG = '1'

    // 1. Validate GITHUB_TOKEN
    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error(
      'GITHUB_TOKEN is not set — add `env: GITHUB_TOKEN: ${{ github.token }}` to your workflow step.'
    )

    // 2. Validate pull_request event context
    const context = github.context
    if (!context.payload.pull_request) {
      throw new Error(
        'This action must be triggered by a pull_request event (opened, synchronize, reopened).'
      )
    }

    const pr        = context.payload.pull_request
    const prNumber  = pr.number as number
    const prTitle   = (pr.title as string) ?? ''
    const repo      = process.env.GITHUB_REPOSITORY ?? ''
    const [owner, repoName] = repo.split('/')
    if (!owner || !repoName) throw new Error(`GITHUB_REPOSITORY is not set or malformed (got: "${repo}")`)

    // 3. Read inputs
    const model                 = core.getInput('model')                  || 'qwen3.5:9b'
    const baseUrl               = core.getInput('base_url')               || 'http://localhost:11434'
    const temperature           = parseFloat(core.getInput('temperature') || '0.2')
    const maximumResponseTokens = parseInt(core.getInput('maximum_response_tokens') || '2048')
    // Enforce 300-char cap at runtime — action.yml documents this limit but callers
    // can pass arbitrary-length strings. Silently truncate rather than error to
    // avoid breaking workflows over a minor misconfiguration.
    const promptExtra           = core.getInput('prompt_extra').slice(0, 300)

    // 4. Resolve binary path
    const actionPath = process.env.GITHUB_ACTION_PATH ?? path.join(__dirname, '..')
    const bin = path.join(actionPath, 'local-ai-cli-bin')

    if (!fs.existsSync(bin)) {
      throw new Error(
        `local-ai-cli-bin not found at ${bin}. ` +
        'This action requires a self-hosted macOS runner with Ollama installed.'
      )
    }
    try {
      fs.accessSync(bin, fs.constants.X_OK)
    } catch {
      throw new Error(
        `local-ai-cli-bin at ${bin} is not executable. Run: chmod +x local-ai-cli-bin and recommit.`
      )
    }

    const octokit = github.getOctokit(token)

    // 5. Fetch PR changed files
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo: repoName,
      pull_number: prNumber,
      per_page: 100,
    })

    if (files.length === 0) {
      core.info('[local-ai] PR has no changed files — skipping review.')
      return
    }

    // GitHub API hard-caps listFiles at 100. Warn so the reviewer knows the
    // file list may be incomplete — the diff will also be truncated below.
    if (files.length === 100) {
      core.warning('[local-ai] PR has ≥50 changed files — GitHub API returns max 100. File list may be incomplete.')
    }

    // 6. Build diff block (cap at 60K chars to stay within model context)
    const MAX_PATCH_CHARS = 60_000
    let diffBlock = ''
    let truncated = false

    for (const f of files) {
      if (!f.patch) continue
      const chunk = `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\`\n\n`
      if ((diffBlock + chunk).length > MAX_PATCH_CHARS) {
        truncated = true
        break
      }
      diffBlock += chunk
    }

    if (!diffBlock) {
      core.info('[local-ai] No patchable diff content found — skipping review.')
      return
    }

    if (truncated) {
      core.warning(`[local-ai] Diff truncated at ${MAX_PATCH_CHARS} chars (${files.length} files total)`)
      diffBlock += `\n> ⚠️ Diff truncated — ${files.length} files changed, showing partial diff only.\n`
    }

    // 7. Build prompt
    const instructions = [
      'You are a senior software engineer performing a concise, constructive code review.',
      'Focus on: bugs, security issues, Swift best practices, performance, and code clarity.',
      'Use Markdown. Group feedback by filename using ### headers.',
      'Use bullet points for individual issues. Be specific — reference line numbers where possible.',
      'Do NOT summarise what the code does. Only flag issues, risks, and concrete suggestions.',
      'If there are no issues in a file, skip it entirely.',
    ].join(' ')

    const prompt = [
      `Review the following pull request diff.`,
      `PR #${prNumber}: "${prTitle}"`,
      '',
      diffBlock,
      ...(promptExtra ? [`\nExtra instructions: ${promptExtra}`] : []),
    ].join('\n')

    // 8. Call local-ai-cli with retry (same cold-start pattern as afm-release-notes-action)
    core.info(`[local-ai] Calling ${model} via Ollama...`)
    let review = ''
    try {
      review = localAiCli(bin, prompt, {
        instructions,
        model,
        baseUrl,
        temperature,
        maximumResponseTokens,
      })
    } catch (e) {
      core.debug(`[local-ai] Attempt 1 error: ${String(e)}`)
      if (isFatalError(e)) throw e
      core.info('[local-ai] Attempt 1 failed — retrying in 15s (cold-start model load)...')
      await new Promise(r => setTimeout(r, 15_000))
      review = localAiCli(bin, prompt, {
        instructions,
        model,
        baseUrl,
        temperature,
        maximumResponseTokens,
      })
    }

    if (!review) throw new Error('local-ai-cli returned empty output')

    // 9. Append signature
    const signature = `\n\n---\n> 🤖 AI code review by [github.com/runbot-hq/run-bot](https://github.com/runbot-hq/run-bot)`
    const fullReview = review + signature

    // 10. Delete previous bot comment on any trigger event to avoid stacking reviews.
    // Covers opened, synchronize, and reopened — matching the action trigger list.
    const existingCommentId = await findExistingBotComment(octokit, owner, repoName, prNumber)
    if (existingCommentId) {
      core.info(`[local-ai] Deleting previous bot review comment ${existingCommentId}`)
      await octokit.rest.issues.deleteComment({
        owner,
        repo: repoName,
        comment_id: existingCommentId,
      })
    }

    // 11. Post review as PR comment
    const { data: comment } = await octokit.rest.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body: fullReview,
    })

    core.info(`[local-ai] Review posted: ${comment.html_url}`)
    core.setOutput('review_body', fullReview)

    // 12. Step summary
    await core.summary
      .addHeading(`🤖 AI Code Review: PR #${prNumber}`)
      .addRaw(`**Model:** ${model}\n`)
      .addRaw(`**Runner:** ${process.env.RUNNER_NAME ?? 'unknown'}\n`)
      .addRaw(`**Files reviewed:** ${files.length} (${truncated ? 'diff truncated' : 'full diff'})\n\n`)
      .addRaw(review)
      .write()

    core.info('[local-ai] Done.')
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

run()
