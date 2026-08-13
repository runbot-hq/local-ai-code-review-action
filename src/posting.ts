import * as core from '@actions/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { BOT_SIGNATURE } from './constants'
import { withRetry, findAllBotCommentIds, networkDiag } from './github'
import type { ActionConfig } from './config'
import type { ReviewContext } from './review-context'
import type { InferenceResult } from './inference'

export interface PublishReviewOptions {
  result: InferenceResult
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

  // Invalid model output must never create or delete comments, but must still
  // produce outputs and diagnostics so the failure is visible to callers.
  if (!result.valid) {
    core.warning(
      '[step 5/5] Structured output invalid — ' +
      'skipping PR comment; preserving existing bot comments'
    )
  } else if (
    skipCommentIfNoIssues &&
    result.noIssuesFound
  ) {
    core.info(
      '[step 5/5] skip_comment_if_no_issues=true and ' +
      'no issues found — skipping comment post'
    )

    // All-clear cleanup only applies when replacement mode is enabled; in
    // append mode previous comments are left as-is.
    if (replaceExistingComment) {
      const existingIds = await withRetry(
        'find-comments',
        () =>
          findAllBotCommentIds(
            octokit,
            owner,
            repoName,
            prNumber
          )
      )

      for (const id of existingIds) {
        core.info(
          `[step 5/5] deleting stale bot comment id=${id}...`
        )

        await withRetry(
          `delete-comment-${id}`,
          () =>
            octokit.rest.issues.deleteComment({
              owner,
              repo: repoName,
              comment_id: id,
            })
        )

        core.info(
          `[step 5/5] deleted stale bot comment id=${id}`
        )
      }

      if (existingIds.length === 0) {
        core.info(
          '[step 5/5] no previous bot comments to delete'
        )
      }
    }
  } else {
    if (replaceExistingComment) {
      const existingIds = await withRetry(
        'find-comments',
        () =>
          findAllBotCommentIds(
            octokit,
            owner,
            repoName,
            prNumber
          )
      )

      // Existing comments must be deleted before the new one is created.
      // If deletion fails, withRetry will throw and the new comment will not
      // be posted, preventing duplicate bot comments on the PR.
      for (const id of existingIds) {
        core.info(
          `[step 5/5] deleting bot comment id=${id}...`
        )

        await withRetry(
          `delete-comment-${id}`,
          () =>
            octokit.rest.issues.deleteComment({
              owner,
              repo: repoName,
              comment_id: id,
            })
        )

        core.info(
          `[step 5/5] deleted bot comment id=${id}`
        )
      }

      if (existingIds.length === 0) {
        core.info(
          '[step 5/5] no previous bot comments to delete'
        )
      }
    } else {
      core.info(
        '[step 5/5] replace_existing_comment=false — ' +
        'preserving all prior bot comments'
      )
    }

    core.info(
      `[step 5/5] calling createComment ` +
      `(body=${fullReview.length} chars)...`
    )

    const createResponse = await withRetry(
      'create-comment',
      () =>
        octokit.rest.issues.createComment({
          owner,
          repo: repoName,
          issue_number: prNumber,
          body: fullReview,
        })
    )

    core.info(
      `[step 5/5] Review posted: ` +
      `${createResponse.data.html_url}`
    )
  }

  core.setOutput('review_body', fullReview)

  try {
    // RUNNER_TEMP is required for self-hosted runners; os.tmpdir() is used as a
    // fallback for local runs.  The path must be job-scoped so the post script
    // can locate the file after the main step completes.
    const runnerTemp =
      process.env.RUNNER_TEMP ?? os.tmpdir()

    // The review file must remain available for the post script, which runs
    // after the main action step exits.
    const reviewFile = path.join(
      runnerTemp,
      `ai-review-${prNumber}-${Date.now()}.md`
    )

    fs.writeFileSync(
      reviewFile,
      fullReview,
      'utf8'
    )

    core.setOutput(
      'review_file',
      reviewFile
    )

    // core.saveState() is required because action outputs are not available
    // to the post script; state is the only supported cross-step channel.
    core.saveState(
      'review_file',
      reviewFile
    )

    core.info(
      `[step 5/5] Review file: ${reviewFile}`
    )
  } catch (e) {
    // Review-file writing is best-effort; failure must not abort the completed
    // review or prevent the job summary from being written.
    core.warning(
      '[step 5/5] Could not write review file — ' +
      'review_file output will be absent: ' +
      String(e)
    )
  }

  await core.summary
    .addHeading(
      `🤖 AI Code Review: PR #${prNumber}`
    )
    .addRaw(`**Model:** ${model}\n`)
    .addRaw(
      `**Tier:** ${result.tier} ` +
      `(reviewable lines: ${result.reviewableLines})\n`
    )
    .addRaw(
      `**Runner:** ` +
      `${process.env.RUNNER_NAME ?? 'unknown'}\n`
    )
    .addRaw(
      `**Files reviewed:** ${context.files.length} ` +
      `(${result.truncated
        ? 'diff truncated'
        : 'full diff'})\n\n`
    )
    .addRaw(result.markdown)
    .write()
}
