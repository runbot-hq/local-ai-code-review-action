import * as core from '@actions/core'
import * as os from 'os'
import { parseAlwaysReviewEntirePR } from './scope'

export interface ActionConfig {
  token: string
  model: string
  baseUrl: string
  temperature: number
  timeoutSeconds: number
  promptExtra: string
  numCtx: number
  repeatPenalty: number
  thinkOverride: boolean
  replaceExistingComment: boolean
  skipCommentIfNoIssues: boolean
  maximumResponseTokensOverride: number | undefined
  skipLabel: string
  alwaysReviewEntirePR: boolean
  debug: boolean
}

export function readConfig(): ActionConfig {
  if (core.getInput('debug') === 'true') process.env.ACTIONS_STEP_DEBUG = '1'

  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error(
    'GITHUB_TOKEN is not set — add `env: GITHUB_TOKEN: ${{ github.token }}` to your workflow step.'
  )
  core.info('[init] GITHUB_TOKEN: present')
  core.info(`[init] Node version: ${process.version}`)
  core.info(`[init] Platform: ${process.platform} ${process.arch}`)
  core.info(`[init] HOME: ${os.homedir()}`)
  core.info(`[init] Runner: ${process.env.RUNNER_NAME ?? 'unknown'}`)

  const model          = core.getInput('model')     || 'qwen3.5:9b'
  const baseUrl        = core.getInput('base_url')  || 'http://localhost:11434'
  const temperature    = parseFloat(core.getInput('temperature') || '0.2')
  const timeoutSeconds = parseInt(core.getInput('timeout_seconds') || '600', 10)

  const promptExtraRaw = core.getInput('prompt_extra')
  if (promptExtraRaw.length > 300) core.warning('[init] prompt_extra was truncated to 300 chars')
  const promptExtra = promptExtraRaw.slice(0, 300)

  // num_ctx defaults to 16,384 — the context window that comfortably fits the
  // 60,000-character diff budget plus prompt overhead without OOM-killing Ollama.
  const numCtx = parseInt(core.getInput('num_ctx') || '16384', 10)
  core.info(`[init] num_ctx: ${numCtx}`)

  // repeat_penalty defaults to 1.2 — empirically chosen after observing the model
  // enter repetition loops (repeating the same issue or phrase verbatim) at the
  // default value of 1.0.
  const repeatPenalty = parseFloat(core.getInput('repeat_penalty') || '1.2')
  core.info(`[init] repeat_penalty: ${repeatPenalty}`)

  // think interacts with tier selection: thinkOverride=true only activates the
  // extended reasoning path when the tier resolved to 'deep'; shallow-tier runs
  // always use think=false regardless of this input.
  const rawThink = core.getInput('think')
  if (rawThink && rawThink !== 'true' && rawThink !== 'false') {
    core.warning(`[init] think: unrecognised value "${rawThink}" — treating as false. Use 'true' or 'false'.`)
  }
  const thinkOverride = rawThink === 'true'
  core.info(`[init] think override: ${thinkOverride}`)

  const rawReplaceExistingComment = core.getInput('replace_existing_comment')
  if (rawReplaceExistingComment && rawReplaceExistingComment !== 'true' && rawReplaceExistingComment !== 'false') {
    core.warning(`[init] replace_existing_comment: unrecognised value "${rawReplaceExistingComment}" — treating as false. Use 'true' or 'false'.`)
  }
  const replaceExistingComment = rawReplaceExistingComment === 'true'
  core.info(`[init] replace_existing_comment: ${replaceExistingComment}`)

  // skip_comment_if_no_issues=true suppresses the PR comment but does not
  // suppress action outputs or the job summary — callers still get the review
  // body via outputs and the summary is always written for observability.
  const rawSkipCommentIfNoIssues = core.getInput('skip_comment_if_no_issues')
  if (rawSkipCommentIfNoIssues && rawSkipCommentIfNoIssues !== 'true' && rawSkipCommentIfNoIssues !== 'false') {
    core.warning(`[init] skip_comment_if_no_issues: unrecognised value "${rawSkipCommentIfNoIssues}" — treating as true (default). Use 'true' or 'false'.`)
  }
  const skipCommentIfNoIssues = rawSkipCommentIfNoIssues !== 'false'
  core.info(`[init] skip_comment_if_no_issues: ${skipCommentIfNoIssues}`)

  // maximum_response_tokens has no fixed input default; callers supply undefined
  // and inference applies tier defaults: 4,096 for shallow reviews and 8,192 for
  // deep reviews.  An explicit input value overrides both tier defaults.
  const rawMaxTokens = core.getInput('maximum_response_tokens')
  const maximumResponseTokensOverride = rawMaxTokens ? parseInt(rawMaxTokens, 10) : undefined

  const rawSkipLabel = core.getInput('skip_review_label')
  const skipLabelTrimmed = rawSkipLabel.trim()

  if (!skipLabelTrimmed && rawSkipLabel.length > 0) {
    core.warning(
      '[init] skip_review_label is whitespace-only — ' +
      'falling back to default "[skip ai review]"'
    )
  }

  const skipLabel = (
    skipLabelTrimmed ||
    '[skip ai review]'
  ).toLowerCase()
  core.info(`[init] skip_review_label: "${skipLabel}"`)

  const rawAlwaysReviewEntirePR = core.getInput('always_review_entire_pr')
  const parsedAlwaysReviewEntirePR = parseAlwaysReviewEntirePR(rawAlwaysReviewEntirePR)
  if (parsedAlwaysReviewEntirePR === undefined) {
    core.warning(
      `[init] always_review_entire_pr: unrecognised value ` +
      `"${rawAlwaysReviewEntirePR}" — treating as false. ` +
      `Use 'true' or 'false'.`
    )
  }
  const alwaysReviewEntirePR = parsedAlwaysReviewEntirePR ?? false

  return {
    token,
    model,
    baseUrl,
    temperature,
    timeoutSeconds,
    promptExtra,
    numCtx,
    repeatPenalty,
    thinkOverride,
    replaceExistingComment,
    skipCommentIfNoIssues,
    maximumResponseTokensOverride,
    skipLabel,
    alwaysReviewEntirePR,
    debug: core.getInput('debug') === 'true',
  }
}
