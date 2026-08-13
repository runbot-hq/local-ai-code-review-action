import * as core from '@actions/core'
import * as github from '@actions/github'
import { withRetry } from './github'
import { reviewScopeForAction } from './scope'
import type { ActionConfig } from './config'
import type { ChangedFile } from './diff'

type HeadCommit = Awaited<
  ReturnType<
    ReturnType<typeof github.getOctokit>['rest']['repos']['getCommit']
  >
>['data']

interface ContextBase {
  token: string
  owner: string
  repoName: string
  prNumber: number
  prTitle: string
  headSha: string
  octokit: ReturnType<typeof github.getOctokit>
}

// Phase-1 result: PR validated, skip checks done.
// Discriminated on `skipped` so TypeScript prevents passing a skipped context
// into resolveReviewFiles() where headCommit would be absent.
export type ResolvedContext =
  | (ContextBase & { skipped: true;  skipReason: string })
  | (ContextBase & { skipped: false; headCommit: HeadCommit })

// Phase-2 result: scope resolved, files fetched, ready for inference.
export interface ReviewContext {
  token: string
  owner: string
  repoName: string
  prNumber: number
  prTitle: string
  headSha: string
  files: ChangedFile[]
  /** Set when the run should be skipped — caller logs this and returns early */
  skipReason?: string
  octokit: ReturnType<typeof github.getOctokit>
}

// Phase 1: validate PR context, check title/body/commit-message skip labels,
// and fetch the head commit (reused in phase 2 for synchronize scope).
export async function resolveReviewContext(
  config: ActionConfig
): Promise<ResolvedContext> {
  const ctx = github.context
  if (!ctx.payload.pull_request) {
    throw new Error(
      'This action must be triggered by a pull_request event (opened, synchronize, reopened).'
    )
  }

  const pr        = ctx.payload.pull_request
  const prNumber  = pr.number as number
  const prTitle   = (pr.title as string) ?? ''
  // payload.head_commit is unavailable on pull_request events; the head SHA
  // must be read from pr.head.sha instead.
  const headSha   = pr.head.sha as string
  const repo      = process.env.GITHUB_REPOSITORY ?? ''
  const [owner, repoName] = repo.split('/')
  if (!owner || !repoName) {
    throw new Error(`GITHUB_REPOSITORY is not set or malformed (got: "${repo}")`)
  }
  core.info(`[init] PR: #${prNumber} "${prTitle}" in ${owner}/${repoName}`)

  const octokit = github.getOctokit(config.token)

  const base: ContextBase = { token: config.token, owner, repoName, prNumber, prTitle, headSha, octokit }

  // Title and body are checked before the API request; they are already present
  // in the webhook payload so this costs nothing and avoids an unnecessary call.
  const prBody = (pr.body as string) ?? ''
  if (
    prTitle.toLowerCase().includes(config.skipLabel) ||
    prBody.toLowerCase().includes(config.skipLabel)
  ) {
    return {
      ...base,
      skipped: true,
      skipReason: `[init] Skip label "${config.skipLabel}" detected in title/body — skipping AI review.`,
    }
  }

  core.info(`[init] Fetching head commit message for skip check (sha: ${headSha})...`)
  // The commit response is reused in phase 2 for head-commit file selection,
  // avoiding a second API call for synchronize events.
  const commitResponse = await withRetry('fetch-head-commit', () =>
    octokit.rest.repos.getCommit({ owner, repo: repoName, ref: headSha, per_page: 100 })
  )
  const headCommit = commitResponse.data
  const headCommitMessage = (headCommit.commit.message ?? '').toLowerCase()
  core.info(
    `[init] Head commit message: ${headCommitMessage.slice(0, 120)}${headCommitMessage.length > 120 ? '…' : ''}`
  )

  if (headCommitMessage.includes(config.skipLabel)) {
    return {
      ...base,
      skipped: true,
      skipReason: `[init] Skip label "${config.skipLabel}" detected in commit message — skipping AI review.`,
    }
  }
  core.info('[init] skip_review_label: not found — proceeding with review')

  return { ...base, skipped: false, headCommit }
}

// Phase 2: determine review scope, fetch files (reusing the head commit for
// synchronize), and emit step-2 logs. Runs after ensureBinary() so step-1
// logs always precede step-2 logs, matching the original execution order.
export async function resolveReviewFiles(
  resolved: ResolvedContext & { skipped: false },
  config: ActionConfig
): Promise<ReviewContext> {
  const { token, owner, repoName, prNumber, prTitle, headSha, headCommit, octokit } = resolved
  const base: Omit<ReviewContext, 'files' | 'skipReason'> = {
    token, owner, repoName, prNumber, prTitle, headSha, octokit,
  }

  const ctx = github.context
  const eventAction = ctx.payload.action
  const reviewScope = reviewScopeForAction(eventAction, config.alwaysReviewEntirePR)
  core.info(
    `[step 2/5] always_review_entire_pr=${config.alwaysReviewEntirePR}, ` +
    `effective_scope=${reviewScope}, action=${eventAction}`
  )

  let files: ChangedFile[]

  // synchronize uses head-commit files (already fetched above) so that only the
  // files touched by the triggering push are reviewed.  All other supported
  // actions (opened, reopened) use the full PR file list instead.
  if (reviewScope === 'head-commit') {
    files = (headCommit.files ?? []).map((f) => ({
      filename:  f.filename,
      status:    f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch:     f.patch,
    }))
    core.info(`[step 2/5] Review scope: head commit ${headSha} (${files.length} file(s))`)
  } else {
    const prFilesResponse = await withRetry('fetch-pr-files', () =>
      octokit.rest.pulls.listFiles({ owner, repo: repoName, pull_number: prNumber, per_page: 100 })
    )
    files = prFilesResponse.data.map((f) => ({
      filename:  f.filename,
      status:    f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch:     f.patch,
    }))
    core.info(`[step 2/5] Review scope: full PR #${prNumber} (${files.length} file(s), action=${eventAction})`)
  }

  for (const f of files) {
    core.info(`  • ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
  }

  if (files.length === 0) {
    return { ...base, files, skipReason: '[step 2/5] No changed files — skipping review.' }
  }
  if (files.length === 100) {
    core.warning(`[step 2/5] ${reviewScope} file list reached the 100-file cap`)
  }

  return { ...base, files }
}
