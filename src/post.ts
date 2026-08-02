import * as core from '@actions/core'
import { execFileSync } from 'child_process'

// post: entry point — runs automatically after the main action step completes.
//
// Reads review_file from state (saved by main via core.saveState) and cats
// it to stdout. This gives consumers a clean, chrome-free output step with
// zero configuration required on their end.
//
// post-if: success() in action.yml ensures this only runs when the main
// step succeeded (i.e. a review was actually posted and the file written).
async function post(): Promise<void> {
  const reviewFile = core.getState('review_file')
  if (!reviewFile) {
    core.info('[post] review_file state not set — review was skipped or file write failed, nothing to display')
    return
  }
  // execFileSync with stdio: inherit streams directly to the runner log.
  // No env var, no shell expansion — just the file content, nothing else.
  // Wrapped in try/catch: a cat failure (missing file, bad mount, cat not on
  // PATH) must not throw and fail the post step — the review is already posted
  // to the PR at this point. Mirror the best-effort contract of the file write
  // in index.ts.
  try {
    execFileSync('cat', [reviewFile], { stdio: 'inherit' })
  } catch (e) {
    core.warning(`[post] Failed to cat review file: ${String(e)}`)
  }
}

post()
