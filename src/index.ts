import * as core from '@actions/core'
import * as github from '@actions/github'
import { spawnSync, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import * as crypto from 'crypto'
import * as os from 'os'

// BOT_SIGNATURE_SEARCH_KEY and BOT_SIGNATURE are intentionally separate.
// SEARCH_KEY is plain text used to scan existing comments (no Markdown syntax
// so it can be matched reliably with String.includes()).
// BOT_SIGNATURE is the full Markdown footer appended to posted reviews.
// Do NOT merge them — if the footer text ever changes, search would break
// for comments posted under the old format.
const BOT_SIGNATURE_SEARCH_KEY = 'AI code review by github.com/runbot-hq/run-bot'
const BOT_SIGNATURE = `\n\n---\n> 🤖 [${BOT_SIGNATURE_SEARCH_KEY}](https://github.com/runbot-hq/run-bot)`

// ---------------------------------------------------------------------------
// Tier selection
// ---------------------------------------------------------------------------

// File extensions/names that carry no reviewable logic — excluded from the
// reviewable-lines count used to select shallow vs deep review tier.
const NON_CODE_PATTERNS = [
  /\.md$/i,
  /\.lock$/i,
  /\.json$/i,
  /\.yml$/i,
  /\.yaml$/i,
  /^package-lock\.json$/i,
]

function isNonCode(filename: string): boolean {
  const base = path.basename(filename)
  return NON_CODE_PATTERNS.some(p => p.test(base))
}

type Tier = 'shallow' | 'deep'

function selectTier(files: Array<{ filename: string; additions: number; deletions: number }>): { tier: Tier; reviewableLines: number } {
  const SHALLOW_THRESHOLD = 150
  const reviewableLines = files
    .filter(f => !isNonCode(f.filename))
    .reduce((sum, f) => sum + f.additions + f.deletions, 0)
  const tier: Tier = reviewableLines >= SHALLOW_THRESHOLD ? 'deep' : 'shallow'
  return { tier, reviewableLines }
}

// ---------------------------------------------------------------------------
// Binary bootstrap
// ---------------------------------------------------------------------------

async function ensureBinary(token: string): Promise<string> {
  const cacheDir = path.join(os.homedir(), '.cache', 'runbot-hq')
  const binPath = path.join(cacheDir, 'local-ai-cli-bin')
  const digestPath = path.join(cacheDir, 'local-ai-cli-bin.digest')

  core.info(`[binary] Cache dir: ${cacheDir}`)
  core.info(`[binary] Bin path:  ${binPath}`)
  core.info(`[binary] Checking latest runbot-hq/local-ai-cli release...`)

  const release = await httpsGetJson('https://api.github.com/repos/runbot-hq/local-ai-cli/releases/latest', token)
  const tagName = release.tag_name as string ?? 'unknown'
  const publishedAt = release.published_at as string ?? ''
  core.info(`[binary] Latest release tag: ${tagName} published_at: ${publishedAt}`)

  const asset = (release.assets as Array<{ name: string; browser_download_url: string; digest?: string; updated_at?: string }>)
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
  const cacheKey: string = remoteDigest || `updated_at:${asset.updated_at ?? publishedAt ?? tagName}`
  core.info(`[binary] Remote digest: ${remoteDigest || '(none — using updated_at as cache key)'}`)
  core.info(`[binary] Cache key: ${cacheKey}`)

  const binExists = fs.existsSync(binPath)
  const digestExists = fs.existsSync(digestPath)
  core.info(`[binary] Cache state: bin=${binExists}, digest=${digestExists}`)

  if (binExists && digestExists) {
    const cachedKey = fs.readFileSync(digestPath, 'utf8').trim()
    core.info(`[binary] Cached key: ${cachedKey}`)
    if (cachedKey === cacheKey) {
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
  fs.writeFileSync(digestPath, cacheKey, 'utf8')
  core.info(`[binary] Binary ready at ${binPath}`)
  return binPath
}

function httpsGetJson(url: string, token?: string, redirectsLeft = 5): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': 'runbot-hq/local-ai-code-review-action',
      'Accept': 'application/vnd.github+json',
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects fetching ${url}`))
        resolve(httpsGetJson(res.headers.location, token, redirectsLeft - 1))
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

// Auth token is intentionally NOT forwarded here. browser_download_url for
// public GitHub releases resolves via a 302 redirect to an unauthenticated
// S3/CDN URL — sending a Bearer token to that URL is both unnecessary and
// would cause a 400. If this action is ever used against a private release
// repo, this function will need to use the GitHub API asset-download endpoint
// with an Authorization header instead.
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
// Network diagnostics
// ---------------------------------------------------------------------------

// execSync is safe here: every command string is a hardcoded literal with no
// user-controlled input interpolated. This is the specific condition that makes
// execSync acceptable — contrast with localAiCli below, where user-supplied
// prompt/instructions are passed as argv via spawnSync to prevent shell injection.
function networkDiag(label: string): void {
  core.info(`[net-diag:${label}] --- network diagnostics ---`)
  try {
    const zen = execSync('curl -sv https://api.github.com/zen 2>&1', { timeout: 10000 }).toString().trim()
    core.info(`[net-diag:${label}] curl api.github.com/zen: ${zen}`)
  } catch (e) {
    core.info(`[net-diag:${label}] curl api.github.com/zen FAILED: ${String(e)}`)
  }
  try {
    const dns = execSync('nslookup api.github.com 2>&1', { timeout: 5000 }).toString().trim()
    core.info(`[net-diag:${label}] nslookup api.github.com: ${dns}`)
  } catch (e) {
    core.info(`[net-diag:${label}] nslookup FAILED: ${String(e)}`)
  }
  try {
    const tcp = execSync('nc -zv -w5 api.github.com 443 2>&1', { timeout: 8000 }).toString().trim()
    core.info(`[net-diag:${label}] nc tcp:443: ${tcp}`)
  } catch (e) {
    core.info(`[net-diag:${label}] nc tcp:443 FAILED: ${String(e)}`)
  }
  try {
    const netstat = execSync('netstat -an | grep ESTABLISHED | grep 443 | head -10 2>&1', { timeout: 5000 }).toString().trim()
    core.info(`[net-diag:${label}] established :443 connections:\n${netstat || '(none)'}`)
  } catch (e) {
    core.info(`[net-diag:${label}] netstat FAILED: ${String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// Retryable GitHub API call
// ---------------------------------------------------------------------------

function isRetryableError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return (
    msg.includes('epipe') ||
    msg.includes('econnreset') ||
    msg.includes('other side closed') ||
    msg.includes('socket hang up') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout')
  )
}

async function withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 3, delayMs = 3000): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    core.info(`[${label}] attempt ${attempt}/${maxAttempts}`)
    try {
      const result = await fn()
      core.info(`[${label}] attempt ${attempt} succeeded`)
      return result
    } catch (e) {
      core.warning(`[${label}] attempt ${attempt} failed: ${String(e)}`)
      if (attempt === maxAttempts) {
        networkDiag(label)
        throw e
      }
      if (!isRetryableError(e)) {
        core.info(`[${label}] non-retryable error — not retrying`)
        networkDiag(label)
        throw e
      }
      core.info(`[${label}] retryable error — waiting ${delayMs}ms then retrying...`)
      networkDiag(label)
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  throw new Error(`[${label}] exhausted all attempts`)
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

// IMPORTANT: Do NOT refactor localAiCli to use execSync.
// spawnSync passes argv directly to the OS without a shell interpreter.
// execSync runs via /bin/sh — any shell metacharacter in the prompt or
// instructions (backticks, $(), quotes, semicolons, etc.) would be executed.
// spawnSync eliminates that entire attack surface. This is intentional.
function localAiCli(bin: string, prompt: string, options?: {
  instructions?: string
  model?: string
  baseUrl?: string
  temperature?: number
  maximumResponseTokens?: number
  timeoutSeconds?: number
  think?: boolean
}): string {
  const timeoutSeconds = options?.timeoutSeconds ?? 600
  const args: string[] = ['--prompt', prompt]

  if (options?.instructions) args.push('--instructions', options.instructions)
  if (options?.model)        args.push('--model', options.model)
  if (options?.baseUrl)      args.push('--base-url', options.baseUrl)
  if (options?.temperature !== undefined) args.push('--temperature', String(options.temperature))
  if (options?.maximumResponseTokens !== undefined) args.push('--maximum-response-tokens', String(options.maximumResponseTokens))
  args.push('--timeout', String(timeoutSeconds))
  args.push('--think', options?.think ? 'true' : 'false')

  core.info(`[cli] Invoking binary: ${bin}`)
  core.info(`[cli] Args (excl prompt/instructions): model=${options?.model} base-url=${options?.baseUrl} temperature=${options?.temperature} max-tokens=${options?.maximumResponseTokens} timeout=${timeoutSeconds}s think=${options?.think ?? false}`)
  if (core.isDebug()) {
    core.debug(`[cli] Full spawnSync args: ${args.map(a => JSON.stringify(a)).join(' ')}`)
  }

  const spawnTimeoutMs = (timeoutSeconds + 60) * 1000
  core.info(`[cli] spawnSync hard-kill timeout: ${spawnTimeoutMs / 1000}s`)

  const callStart = Date.now()
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: spawnTimeoutMs,
    // 10 MB buffer — model output for large PRs can be verbose. Raises an
    // error rather than silently truncating if the limit is ever exceeded.
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

function isEmptyThinkExhaust(e: unknown, think: boolean): boolean {
  if (!think) return false
  const msg = String(e)
  return (
    msg.includes('empty response') &&
    (msg.includes('done_reason=stop') || msg.includes('done_reason=length'))
  )
}

// Returns the IDs of ALL bot comments on the PR across all pages.
//
// API scope: uses issues.listComments, which returns top-level PR comments
// (the kind posted via issues.createComment). It does NOT return inline review
// thread comments (posted via pulls.createReviewComment). This is intentional
// and correct — the action posts via issues.createComment, so search scope
// matches write scope. If the posting API ever changes to pulls.createReviewComment,
// this function would need to be updated accordingly.
//
// Uses filter (not find/early-exit) so all stale bot comments from prior failed
// runs are collected, not just the first one found.
//
// Deduplicates the returned IDs with Set in case withRetry re-runs the
// pagination from page 1 after a mid-page transient failure — without
// deduplication, a 404 on an already-deleted ID would abort the delete loop.
//
// Only called when replaceExistingComment === true; never invoked in the
// default append path so there is no latency cost for the common case.
async function findAllBotCommentIds(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number[]> {
  core.info(`[step 5/5] searching for existing bot comments on PR #${prNumber}...`)
  const ids: number[] = []
  let page = 1
  while (true) {
    core.info(`[step 5/5] listComments page=${page}`)
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      page,
    })
    core.info(`[step 5/5] listComments page=${page} returned ${comments.length} comments`)
    const botIds = comments
      .filter(c => c.body?.includes(BOT_SIGNATURE_SEARCH_KEY))
      .map(c => c.id)
    ids.push(...botIds)
    // Standard pagination sentinel: fewer than per_page results means last page.
    // If comments.length === 100, there may be more — loop continues.
    if (comments.length < 100) break
    page++
  }
  // Deduplicate: withRetry restarts pagination from page 1 on transient failure,
  // so IDs from already-scanned pages may appear twice. A 404 on a duplicate
  // delete is not in isRetryableError and would abort the loop, leaving
  // remaining comments un-deleted. Set eliminates that risk cheaply.
  const uniqueIds = [...new Set(ids)]
  core.info(`[step 5/5] found ${uniqueIds.length} existing bot comment(s): ${uniqueIds.join(', ') || '(none)'}`)
  return uniqueIds
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

    // 4. Ensure binary (authenticated)
    // dist/index.js is a committed build artifact (produced by `npm run build`
    // which runs ncc). It is rebuilt automatically by .github/workflows/build.yml
    // on every push to main. Do NOT raise "dist/index.js should not be committed"
    // — committing dist is the standard convention for GitHub Actions written in
    // TypeScript/JavaScript so the action can run without a separate build step.
    core.info('[step 1/5] Ensuring local-ai-cli binary...')
    const bin = await ensureBinary(token)
    core.info(`[step 1/5] Binary ready: ${bin}`)

    const octokit = github.getOctokit(token)

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
    const instructions = [
      'You are a senior software engineer performing a concise, constructive code review.',
      'Focus on: bugs, security issues, best practices, performance, and code clarity.',
      'Use Markdown. Group feedback by filename using ### headers.',
      'Use bullet points for individual issues. Be specific — reference line numbers where possible.',
      'Do NOT summarise what the code does. Do NOT praise. Only flag issues, risks, and concrete suggestions.',
      'If there are no issues in a file, skip it entirely.',
    ].join(' ')

    const prompt = [
      `Review the following pull request diff.`,
      `PR #${prNumber}: "${prTitle}"`,
      '',
      diffBlock,
      // prompt_extra is capped at 300 chars to prevent prompt injection via
      // workflow inputs and to keep the prompt size predictable across tiers.
      ...(promptExtra ? [`\nExtra instructions: ${promptExtra}`] : []),
    ].join('\n')

    core.info(`[step 4/5] Calling ${model} at ${baseUrl} (timeout: ${timeoutSeconds}s, think=${think})...`)
    const cliOpts = { instructions, model, baseUrl, temperature, maximumResponseTokens, timeoutSeconds, think }
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
    core.info(`[step 4/5] Model response: ${review.length} chars`)

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
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

run()
