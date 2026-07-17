import * as core from '@actions/core'
import * as github from '@actions/github'
import { spawnSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import * as crypto from 'crypto'
import * as os from 'os'

// ---------------------------------------------------------------------------
// Binary bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensures local-ai-cli-bin is present on the runner, downloading it from the
 * latest runbot-hq/local-ai-cli release if the cached copy is missing or stale.
 *
 * Cache location: ~/.cache/runbot-hq/local-ai-cli-bin
 * Staleness check: sha256 digest from the release asset metadata.
 */
async function ensureBinary(): Promise<string> {
  const cacheDir = path.join(os.homedir(), '.cache', 'runbot-hq')
  const binPath = path.join(cacheDir, 'local-ai-cli-bin')
  const digestPath = path.join(cacheDir, 'local-ai-cli-bin.digest')

  core.info('[local-ai] Checking latest local-ai-cli release...')
  const release = await httpsGetJson('https://api.github.com/repos/runbot-hq/local-ai-cli/releases/latest')
  const asset = (release.assets as Array<{ name: string; browser_download_url: string; digest?: string }>)
    .find((a) => a.name === 'local-ai-cli-bin')
  if (!asset) throw new Error('local-ai-cli-bin asset not found in latest release of runbot-hq/local-ai-cli')

  const remoteDigest: string = asset.digest ?? ''

  if (fs.existsSync(binPath) && fs.existsSync(digestPath)) {
    const cachedDigest = fs.readFileSync(digestPath, 'utf8').trim()
    if (remoteDigest && cachedDigest === remoteDigest) {
      core.info(`[local-ai] Cache hit (${remoteDigest}) — skipping download`)
      return binPath
    }
    core.info(`[local-ai] Cache stale (cached: ${cachedDigest}, remote: ${remoteDigest}) — re-downloading`)
  } else {
    core.info('[local-ai] No cached binary — downloading...')
  }

  fs.mkdirSync(cacheDir, { recursive: true })
  core.info(`[local-ai] Downloading from ${asset.browser_download_url}`)
  await httpsDownload(asset.browser_download_url, binPath)

  if (remoteDigest && remoteDigest.startsWith('sha256:')) {
    const expectedHex = remoteDigest.slice('sha256:'.length)
    const actualHex = sha256File(binPath)
    if (actualHex !== expectedHex) {
      fs.unlinkSync(binPath)
      throw new Error(
        `local-ai-cli-bin digest mismatch — expected sha256:${expectedHex}, got sha256:${actualHex}. ` +
        'The downloaded binary may be corrupted. Retry the workflow.'
      )
    }
    core.info(`[local-ai] Digest verified: sha256:${actualHex}`)
  }

  fs.chmodSync(binPath, 0o755)
  fs.writeFileSync(digestPath, remoteDigest, 'utf8')
  core.info(`[local-ai] Binary ready at ${binPath}`)
  return binPath
}

function httpsGetJson(url: string, redirectsLeft = 5): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'runbot-hq/local-ai-code-review-action', 'Accept': 'application/vnd.github+json' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects fetching ${url}`))
        resolve(httpsGetJson(res.headers.location, redirectsLeft - 1))
        return
      }
      if (res.statusCode !== 200) return reject(new Error(`GitHub API returned HTTP ${res.statusCode} for ${url}`))
      let body = ''
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(new Error(`Failed to parse JSON from ${url}: ${e}`)) }
      })
    })
    req.on('error', reject)
  })
}

function httpsDownload(url: string, destPath: string, redirectsLeft = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'runbot-hq/local-ai-code-review-action' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects downloading ${url}`))
        resolve(httpsDownload(res.headers.location, destPath, redirectsLeft - 1))
        return
      }
      if (res.statusCode !== 200) return reject(new Error(`Download returned HTTP ${res.statusCode} for ${url}`))
      const file = fs.createWriteStream(destPath)
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e) })
    })
    req.on('error', reject)
  })
}

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

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
 * spawnSyncTimeoutMs = timeoutSeconds + 60s buffer for process startup
 * and response marshalling. Do NOT set it equal to or below timeoutSeconds.
 */
function localAiCli(bin: string, prompt: string, options?: {
  instructions?: string
  model?: string
  baseUrl?: string
  temperature?: number
  maximumResponseTokens?: number
  timeoutSeconds?: number
}): string {
  const timeoutSeconds = options?.timeoutSeconds ?? 600
  const args: string[] = ['--prompt', prompt]

  if (options?.instructions) args.push('--instructions', options.instructions)
  if (options?.model)        args.push('--model', options.model)
  if (options?.baseUrl)      args.push('--base-url', options.baseUrl)
  if (options?.temperature !== undefined) args.push('--temperature', String(options.temperature))
  if (options?.maximumResponseTokens !== undefined) args.push('--maximum-response-tokens', String(options.maximumResponseTokens))
  args.push('--timeout', String(timeoutSeconds))

  if (core.isDebug()) {
    core.debug(`[local-ai] spawnSync: ${bin} ${args.map(a => JSON.stringify(a)).join(' ')}`)
  }

  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    // Hard-kill at timeoutSeconds + 60s to give the binary time to respect
    // its own --timeout before Node kills the process.
    timeout: (timeoutSeconds + 60) * 1000,
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`local-ai-cli exited ${result.status}: ${result.stderr?.trim()}`)
  }

  return result.stdout.trim()
}

function isFatalError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return (
    msg.includes('invalid --base-url') ||
    msg.includes('http 404') ||
    msg.includes('eacces') ||
    msg.includes('enoent')
  )
}

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

    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error(
      'GITHUB_TOKEN is not set — add `env: GITHUB_TOKEN: ${{ github.token }}` to your workflow step.'
    )

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

    const model                 = core.getInput('model')                  || 'qwen3.5:9b'
    const baseUrl               = core.getInput('base_url')               || 'http://localhost:11434'
    const temperature           = parseFloat(core.getInput('temperature') || '0.2')
    const maximumResponseTokens = parseInt(core.getInput('maximum_response_tokens') || '2048')
    const timeoutSeconds        = parseInt(core.getInput('timeout_seconds') || '600')
    const promptExtra           = core.getInput('prompt_extra').slice(0, 300)

    const bin = await ensureBinary()

    const octokit = github.getOctokit(token)

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

    if (files.length === 100) {
      core.warning('[local-ai] PR has ≥50 changed files — GitHub API returns max 100. File list may be incomplete.')
    }

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

    core.info(`[local-ai] Calling ${model} via Ollama (timeout: ${timeoutSeconds}s)...`)
    let review = ''
    try {
      review = localAiCli(bin, prompt, {
        instructions,
        model,
        baseUrl,
        temperature,
        maximumResponseTokens,
        timeoutSeconds,
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
        timeoutSeconds,
      })
    }

    if (!review) throw new Error('local-ai-cli returned empty output')

    const signature = `\n\n---\n> 🤖 AI code review by [github.com/runbot-hq/run-bot](https://github.com/runbot-hq/run-bot)`
    const fullReview = review + signature

    const existingCommentId = await findExistingBotComment(octokit, owner, repoName, prNumber)
    if (existingCommentId) {
      core.info(`[local-ai] Deleting previous bot review comment ${existingCommentId}`)
      await octokit.rest.issues.deleteComment({
        owner,
        repo: repoName,
        comment_id: existingCommentId,
      })
    }

    const { data: comment } = await octokit.rest.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body: fullReview,
    })

    core.info(`[local-ai] Review posted: ${comment.html_url}`)
    core.setOutput('review_body', fullReview)

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
