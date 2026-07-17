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

async function ensureBinary(): Promise<string> {
  const cacheDir = path.join(os.homedir(), '.cache', 'runbot-hq')
  const binPath = path.join(cacheDir, 'local-ai-cli-bin')
  const digestPath = path.join(cacheDir, 'local-ai-cli-bin.digest')

  core.info(`[binary] Cache dir: ${cacheDir}`)
  core.info(`[binary] Bin path:  ${binPath}`)
  core.info(`[binary] Checking latest runbot-hq/local-ai-cli release...`)

  const release = await httpsGetJson('https://api.github.com/repos/runbot-hq/local-ai-cli/releases/latest')
  const tagName = release.tag_name as string ?? 'unknown'
  core.info(`[binary] Latest release tag: ${tagName}`)

  const asset = (release.assets as Array<{ name: string; browser_download_url: string; digest?: string }>)
    .find((a) => a.name === 'local-ai-cli-bin')
  if (!asset) {
    const assetNames = (release.assets as Array<{ name: string }>).map(a => a.name).join(', ')
    throw new Error(
      `local-ai-cli-bin asset not found in release ${tagName} of runbot-hq/local-ai-cli. ` +
      `Available assets: [${assetNames}]`
    )
  }
  core.info(`[binary] Found asset: ${asset.name} (${asset.browser_download_url})`)

  const remoteDigest: string = asset.digest ?? ''
  core.info(`[binary] Remote digest: ${remoteDigest || '(none provided)'}`)

  const binExists = fs.existsSync(binPath)
  const digestExists = fs.existsSync(digestPath)
  core.info(`[binary] Cache state: bin=${binExists}, digest=${digestExists}`)

  if (binExists && digestExists) {
    const cachedDigest = fs.readFileSync(digestPath, 'utf8').trim()
    core.info(`[binary] Cached digest: ${cachedDigest}`)
    if (remoteDigest && cachedDigest === remoteDigest) {
      const binSize = fs.statSync(binPath).size
      core.info(`[binary] Cache hit ✔ — skipping download (size: ${binSize} bytes)`)
      return binPath
    }
    core.info(`[binary] Cache stale — re-downloading`)
  } else {
    core.info(`[binary] No cached binary — downloading for the first time`)
  }

  fs.mkdirSync(cacheDir, { recursive: true })
  core.info(`[binary] Downloading ${asset.browser_download_url} ...`)
  const downloadStart = Date.now()
  await httpsDownload(asset.browser_download_url, binPath)
  const downloadMs = Date.now() - downloadStart
  const binSize = fs.statSync(binPath).size
  core.info(`[binary] Download complete in ${downloadMs}ms (${binSize} bytes)`)

  if (remoteDigest && remoteDigest.startsWith('sha256:')) {
    const expectedHex = remoteDigest.slice('sha256:'.length)
    core.info(`[binary] Verifying sha256...`)
    const actualHex = sha256File(binPath)
    if (actualHex !== expectedHex) {
      fs.unlinkSync(binPath)
      throw new Error(
        `local-ai-cli-bin digest mismatch — expected sha256:${expectedHex}, got sha256:${actualHex}. ` +
        'The downloaded binary may be corrupted. Retry the workflow.'
      )
    }
    core.info(`[binary] Digest verified ✔ sha256:${actualHex}`)
  } else {
    core.info(`[binary] No sha256 digest to verify — skipping integrity check`)
  }

  fs.chmodSync(binPath, 0o755)
  fs.writeFileSync(digestPath, remoteDigest, 'utf8')
  core.info(`[binary] Binary ready at ${binPath}`)
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
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * Calls local-ai-cli-bin via spawnSync with an explicit argv array.
 * spawnSync passes args directly to the OS without a shell — no metacharacter risk.
 * Do NOT refactor to execSync.
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

  core.info(`[cli] Invoking binary: ${bin}`)
  core.info(`[cli] Args (excl prompt/instructions): model=${options?.model} base-url=${options?.baseUrl} temperature=${options?.temperature} max-tokens=${options?.maximumResponseTokens} timeout=${timeoutSeconds}s`)
  if (core.isDebug()) {
    core.debug(`[cli] Full spawnSync args: ${args.map(a => JSON.stringify(a)).join(' ')}`)
  }

  const spawnTimeoutMs = (timeoutSeconds + 60) * 1000
  core.info(`[cli] spawnSync hard-kill timeout: ${spawnTimeoutMs / 1000}s`)

  const callStart = Date.now()
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: spawnTimeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  })
  const callMs = Date.now() - callStart
  core.info(`[cli] spawnSync returned in ${callMs}ms, exit code: ${result.status}`)

  if (result.error) {
    core.error(`[cli] spawnSync error: ${result.error}`)
    throw result.error
  }
  if (result.stderr) {
    core.info(`[cli] stderr: ${result.stderr.trim()}`)
  }
  if (result.status !== 0) {
    throw new Error(`local-ai-cli exited ${result.status}: ${result.stderr?.trim()}`)
  }

  const outputLen = result.stdout?.length ?? 0
  core.info(`[cli] stdout length: ${outputLen} chars`)
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
    const model                 = core.getInput('model')                  || 'qwen3.5:9b'
    const baseUrl               = core.getInput('base_url')               || 'http://localhost:11434'
    const temperature           = parseFloat(core.getInput('temperature') || '0.2')
    const maximumResponseTokens = parseInt(core.getInput('maximum_response_tokens') || '2048')
    const timeoutSeconds        = parseInt(core.getInput('timeout_seconds') || '600')
    const promptExtra           = core.getInput('prompt_extra').slice(0, 300)
    core.info(`[init] Inputs: model=${model} base_url=${baseUrl} temperature=${temperature} max_tokens=${maximumResponseTokens} timeout=${timeoutSeconds}s`)

    // 4. Ensure binary
    core.info('[step 1/5] Ensuring local-ai-cli binary...')
    const bin = await ensureBinary()
    core.info(`[step 1/5] Binary ready: ${bin}`)

    const octokit = github.getOctokit(token)

    // 5. Fetch PR files
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

    // 6. Build diff block
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

    // 7. Call model
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

    core.info(`[step 4/5] Calling ${model} at ${baseUrl} (timeout: ${timeoutSeconds}s)...`)
    let review = ''
    try {
      review = localAiCli(bin, prompt, { instructions, model, baseUrl, temperature, maximumResponseTokens, timeoutSeconds })
    } catch (e) {
      core.warning(`[step 4/5] Attempt 1 failed: ${String(e)}`)
      if (isFatalError(e)) throw e
      core.info('[step 4/5] Retrying in 15s (cold-start model load)...')
      await new Promise(r => setTimeout(r, 15_000))
      core.info('[step 4/5] Attempt 2...')
      review = localAiCli(bin, prompt, { instructions, model, baseUrl, temperature, maximumResponseTokens, timeoutSeconds })
    }

    if (!review) throw new Error('local-ai-cli returned empty output')
    core.info(`[step 4/5] Model response: ${review.length} chars`)

    // 8. Post comment
    core.info('[step 5/5] Posting PR comment...')
    const signature = `\n\n---\n> 🤖 AI code review by [github.com/runbot-hq/run-bot](https://github.com/runbot-hq/run-bot)`
    const fullReview = review + signature

    const existingCommentId = await findExistingBotComment(octokit, owner, repoName, prNumber)
    if (existingCommentId) {
      core.info(`[step 5/5] Deleting previous bot comment ${existingCommentId}`)
      await octokit.rest.issues.deleteComment({ owner, repo: repoName, comment_id: existingCommentId })
    }

    const { data: comment } = await octokit.rest.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body: fullReview,
    })

    core.info(`[step 5/5] Review posted: ${comment.html_url}`)
    core.setOutput('review_body', fullReview)

    await core.summary
      .addHeading(`🤖 AI Code Review: PR #${prNumber}`)
      .addRaw(`**Model:** ${model}\n`)
      .addRaw(`**Runner:** ${process.env.RUNNER_NAME ?? 'unknown'}\n`)
      .addRaw(`**Files reviewed:** ${files.length} (${truncated ? 'diff truncated' : 'full diff'})\n\n`)
      .addRaw(review)
      .write()

    core.info('=== local-ai-code-review-action done ===')
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

run()
