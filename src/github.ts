import * as core from '@actions/core'
import * as github from '@actions/github'
import { execSync } from 'child_process'
import { BOT_SIGNATURE_SEARCH_KEY } from './constants'

// ---------------------------------------------------------------------------
// Network diagnostics
// ---------------------------------------------------------------------------

// execSync is safe here: every command string is a hardcoded literal with no
// user-controlled input interpolated. This is the specific condition that makes
// execSync acceptable — contrast with localAiCli in cli.ts, where user-supplied
// prompt/instructions are passed as argv via spawnSync to prevent shell injection.
export function networkDiag(label: string): void {
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

export function isRetryableError(e: unknown): boolean {
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

export async function withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 3, delayMs = 3000): Promise<T> {
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
// Bot comment helpers
// ---------------------------------------------------------------------------

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
export async function findAllBotCommentIds(
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
