import * as core from '@actions/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { BOT_SIGNATURE } from './constants'
import { withRetry, findAllBotCommentIds, networkDiag } from './github'
import type { ActionConfig } from './config'
import type { ReviewContext } from './review-context'
import type { ReviewResult } from './inference'

export interface PublishReviewOptions {
  result: ReviewResult & { tier: string; reviewableLines: number; truncated: boolean; filesReviewed: number }
  context: ReviewContext
  config: ActionConfig
}

export async function publishReview(opts: PublishReviewOptions): Promise<void> {
  const { result, context, config } = opts
  const { owner, repoName, prNumber, octokit } = context
  const { replaceExistingComment, skipCommentIfNoIssues, model } = config

  const fullReview = result.markdown + BOT_SIGNATURE

  core.info('[step 5/5] Posting PR comment...')
  core.info(`[step 5/5] review body length: ${result.markdown.length} chars`)
  core.info(`[step 5/5] replace_existing_comment: ${replaceExistingComment}`)

  networkDiag('pre-post')

  core.info(`[step 5/5] full comment length: ${fullReview.length} chars`)

  // Three-way branch on structured output validity and no-issues flag:
  //
  // 1. Invalid structured output — never post; never delete existing comments.
  //    Malformed output must not replace a valid prior review with garbage, and
  //    must not silently appear as a PR comment. Raw text goes to outputs/logs only.
  //
  // 2. Valid output, skip_comment_if_no_issues=true, noIssuesFound=true —
  //    skip the new comment but still clean up stale bot comments so a PR that
  //    had issues and then got fixed doesn’t keep a stale “issues found” comment.
  //
  // 3. Valid output with issues — delete-then-replace (if replace_existing_comment=true)
  //    or append (default). The full review history is preserved on append.

  if (!result.valid) {
    // Outputs and logs only. Never post or delete comments.
    core.setOutput('review_body', fullReview)
    return
  }

  if (skipCommentIfNoIssues && result.noIssuesFound) {
    core.info('[step 5/5] skip_comment_if_no_issues=true and no issues found — skipping comment.')
    // Even when skipping the new comment, still clean up prior bot comments —
    // otherwise a PR that had issues, then got fixed, would keep showing a
    // stale “issues found” comment forever with no replacement.
    const existingIds = await withRetry('find-comments', () =>
      findAllBotCommentIds(octokit, owner, repoName, prNumber)
    )
    for (const id of existingIds) {
      core.info(`[step 5/5] deleting stale bot comment id=${id}...`)
      await withRetry(`delete-comment-${id}`, () =>
        octokit.rest.issues.deleteComment({ owner, repo: repoName, comment_id: id })
      )
      core.info(`[step 5/5] deleted stale bot comment id=${id}`)
    }
    if (existingIds.length === 0) {
      core.info('[step 5/5] no previous bot comments to delete')
    }
  } else {
    if (replaceExistingComment) {
      // Delete ALL existing bot comments before posting a fresh one.
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
        core.info('[step 5/5] no previous bot comments to delete')
      }
    } else {
      core.info('[step 5/5] replace_existing_comment=false — preserving all prior bot comments')
    }

    core.info(`[step 5/5] calling createComment (body=${fullReview.length} chars)...`)
    const createResponse = await withRetry('create-comment', () =>
      octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: prNumber,
        body: fullReview,
      })
    )
    core.info(`[step 5/5] Review posted: ${createResponse.data.html_url}`)
  }

  core.setOutput('review_body', fullReview)

  // Write review to a temp file so the post: script can cat it cleanly.
  try {
    const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir()
    const reviewFile = path.join(runnerTemp, `ai-review-${prNumber}-${Date.now()}.md`)
    fs.writeFileSync(reviewFile, fullReview, 'utf8')
    core.setOutput('review_file', reviewFile)
    core.saveState('review_file', reviewFile)
    core.info(`[step 5/5] Review file: ${reviewFile}`)
  } catch (e) {
    core.warning(`[step 5/5] Could not write review file — review_file output will be absent: ${String(e)}`)
  }

  await core.summary
    .addHeading(`🤖 AI Code Review: PR #${prNumber}`)
    .addRaw(`**Model:** ${model}\n`)
    .addRaw(`**Tier:** ${result.tier} (reviewable lines: ${result.reviewableLines})\n`)
    .addRaw(`**Runner:** ${process.env.RUNNER_NAME ?? 'unknown'}\n`)
    .addRaw(
      `**Files reviewed:** ${context.files.length} ` +
      `(${result.truncated ? 'diff truncated' : 'full diff'})\n\n`
    )
    .addRaw(result.markdown)
    .write()
}
