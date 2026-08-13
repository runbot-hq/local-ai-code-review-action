import * as core from '@actions/core'
import { localAiCli, isFatalError, isEmptyThinkExhaust } from './cli'
import { buildReviewSchema, isParsedReview, renderReviewMarkdown, getRealFiles } from './review'
import { selectTier } from './tier'
import { buildDiffBlock } from './diff'
import type { ActionConfig } from './config'
import type { ChangedFile } from './diff'

export type ReviewResult =
  | {
      valid: true
      raw: string
      markdown: string
      noIssuesFound: boolean
      fileCount: number
    }
  | {
      valid: false
      raw: string
      markdown: string
      error: string
    }

export interface ReviewMetadata {
  tier: string
  reviewableLines: number
  truncated: boolean
}

export type InferenceResult = ReviewResult & ReviewMetadata

export interface RunInferenceOptions {
  bin: string
  files: ChangedFile[]
  prNumber: number
  prTitle: string
  config: ActionConfig
}

export async function runReviewInference(
  opts: RunInferenceOptions
): Promise<InferenceResult> {
  const { bin, files, prNumber, prTitle, config } = opts
  const {
    model, baseUrl, temperature, timeoutSeconds,
    promptExtra, numCtx, repeatPenalty,
    thinkOverride, maximumResponseTokensOverride,
  } = config

  // Tier selection
  const { tier, reviewableLines } = selectTier(files)
  const think = thinkOverride && tier === 'deep'
  const maximumResponseTokens = maximumResponseTokensOverride ?? (tier === 'deep' ? 8192 : 4096)
  core.info(
    `[tier] ${tier}, reviewable_lines=${reviewableLines}, think=${think}, ` +
    `max_tokens=${maximumResponseTokens}${maximumResponseTokensOverride !== undefined ? ' (caller override)' : ''}`
  )

  // Build diff block
  core.info('[step 3/5] Building diff block...')
  const MAX_PATCH_CHARS = 60_000
  const initialDiff = buildDiffBlock(files, MAX_PATCH_CHARS)

  let {
    diffBlock,
    truncated,
    truncatedAt,
    includedFileCount,
    skippedFiles,
  } = initialDiff

  for (const filename of skippedFiles) {
    core.info(`  skip ${filename} — no patch`)
  }

  if (truncated && truncatedAt) {
    core.warning(
      `[step 3/5] Diff truncated at ` +
      `${MAX_PATCH_CHARS} chars — ` +
      `stopping at ${truncatedAt}`
    )
  }

  core.info(
    `[step 3/5] Diff block: ` +
    `${diffBlock.length} chars, ` +
    `truncated=${truncated}`
  )

  if (!diffBlock) {
    return {
      valid: false,
      raw: '',
      markdown: '',
      error: 'no-diff',
      tier,
      reviewableLines,
      truncated,
    }
  }
  if (truncated) {
    diffBlock += `\n> ⚠️ Diff truncated — ${files.length} files changed, showing partial diff only.\n`
  }

  // Instructions live in the user prompt rather than the system prompt because
  // some Qwen/Ollama chat templates silently drop or truncate the system prompt.
  const instructions = [
    'You are a senior software engineer performing a concise, constructive code review.',
    'Review ONLY the diff below. Focus on: bugs, security issues, best practices, performance, and code clarity.',
    'Report concrete, specific issues only — do not summarise or describe what the diff does, and do not praise the code.',
    'For each changed file, list its issues. If a file has no issues, give it an empty issues list.',
    'If the entire diff has no issues at all, return an empty files list.',
  ].join('\n')

  const prompt = [
    instructions,
    '',
    `Review the following pull request diff.`,
    `PR #${prNumber}: "${prTitle}"`,
    '',
    diffBlock,
    ...(promptExtra ? [`\nExtra instructions: ${promptExtra}`] : []),
  ].join('\n')

  // The JSON schema passed via `format` constrains the model to return valid
  // structured output; without it, Ollama returns free-form text.
  const format = JSON.stringify(buildReviewSchema(includedFileCount))

  core.info(
    `[step 4/5] Calling ${model} at ${baseUrl} ` +
    `(timeout: ${timeoutSeconds}s, think=${think}, num_ctx=${numCtx}, repeat_penalty=${repeatPenalty})...`
  )
  const cliOpts = {
    instructions: '',
    model,
    baseUrl,
    temperature,
    maximumResponseTokens,
    numCtx,
    repeatPenalty,
    format,
    timeoutSeconds,
    think,
  }

  let rawReview = ''
  try {
    rawReview = localAiCli(bin, prompt, cliOpts)
  } catch (e) {
    core.warning(`[step 4/5] Attempt 1 failed: ${String(e)}`)
    if (isFatalError(e)) throw e
    if (isEmptyThinkExhaust(e, think)) {
      core.warning('[step 4/5] think=true produced empty response — retrying with think=false')
      rawReview = localAiCli(bin, prompt, { ...cliOpts, think: false })
    } else {
      // Retry degradation: use complete file chunks (no mid-file cuts) up to
      // half the original diff budget, and half the response-token budget.
      const retryDiffLimit = Math.floor(diffBlock.length / 2)
      const reducedRetry = buildDiffBlock(files, retryDiffLimit)

      for (const filename of reducedRetry.skippedFiles) {
        core.info(`  skip ${filename} — no patch`)
      }

      if (reducedRetry.truncated && reducedRetry.truncatedAt) {
        core.warning(
          `[step 3/5] Diff truncated at ` +
          `${retryDiffLimit} chars — ` +
          `stopping at ${reducedRetry.truncatedAt}`
        )
      }

      const usedFullDiffFallback = reducedRetry.diffBlock.length === 0
      const retryDiffBlock = usedFullDiffFallback ? diffBlock : reducedRetry.diffBlock
      const retryFileCount = usedFullDiffFallback ? includedFileCount : reducedRetry.includedFileCount
      const retryMaxTokens = Math.floor(maximumResponseTokens / 2)

      if (usedFullDiffFallback) {
        core.warning(
          `[step 4/5] No complete file fits within the ${retryDiffLimit}-character ` +
          `retry budget — retaining the full diff and reducing output tokens only.`
        )
      }

      const retryPrompt = prompt.replace(diffBlock, () => retryDiffBlock)

      core.info(
        `[step 4/5] Retrying in 15s (cold-start) with degraded budget ` +
        `(diff: ${retryDiffBlock.length}/${diffBlock.length} chars, ` +
        `max_tokens: ${retryMaxTokens}, ` +
        `full_diff_fallback: ${usedFullDiffFallback})...`
      )

      await new Promise(r => setTimeout(r, 15_000))

      core.info('[step 4/5] Attempt 2 (degraded)...')

      rawReview = localAiCli(bin, retryPrompt, {
        ...cliOpts,
        format: JSON.stringify(buildReviewSchema(retryFileCount)),
        maximumResponseTokens: retryMaxTokens,
      })
    }
  }

  if (!rawReview) throw new Error('local-ai-cli returned empty output')
  core.info(`[step 4/5] Review complete (${rawReview.length} chars)`)

  try {
    const parsed = JSON.parse(rawReview)
    if (!isParsedReview(parsed)) {
      throw new Error('parsed JSON did not match expected review shape (missing/invalid "files" array)')
    }
    const markdown = renderReviewMarkdown(parsed)
    // getRealFiles() filters out blank filenames and duplicate model entries
    // before evaluating noIssuesFound, preventing false all-clears.
    const realFiles = getRealFiles(parsed)
    const noIssuesFound = realFiles.every((f) => f.issues.length === 0)
    const emptyFilesList = realFiles.length === 0
    const normalizedEntryCount = parsed.files.length - realFiles.length
    core.info(
      `[step 4/5] Rendered ${realFiles.length} file section(s) ` +
      `from structured output ` +
      `(${normalizedEntryCount} blank or duplicate file ` +
      `entr${normalizedEntryCount === 1 ? 'y' : 'ies'} normalized)`
    )
    core.info(
      `[step 4/5] noIssuesFound=${noIssuesFound}` +
      `${emptyFilesList ? ' (model returned no real per-file entries)' : ''}`
    )
    return {
      valid: true,
      raw: rawReview,
      markdown,
      noIssuesFound,
      fileCount: realFiles.length,
      tier,
      reviewableLines,
      truncated,
    }
  } catch (e) {
    // Invalid structured output is not equivalent to an all-clear result;
    // valid:false signals callers to suppress comment creation/deletion.
    core.warning(
      `[step 4/5] Failed to parse/render structured JSON output — ` +
      `keeping raw response in logs and outputs only: ${String(e)}`
    )
    const markdown =
      `> ⚠️ Model did not return valid structured output — ` +
      `showing raw response.\n\n${rawReview}`
    return {
      valid: false,
      raw: rawReview,
      markdown,
      error: String(e),
      tier,
      reviewableLines,
      truncated,
    }
  }
}
