import * as core from '@actions/core'
import { readConfig } from './config'
import { resolveReviewContext } from './review-context'
import { ensureBinary } from './binary'
import { runReviewInference } from './inference'
import { publishReview } from './posting'

// Prevents ##[...] and ::...:: annotation sequences in arbitrary strings
// (e.g. error messages, model output fragments) from being re-interpreted
// as live GitHub Actions runner commands when passed to core.setFailed(),
// core.warning(), or core.error().
// The :: replacement is scoped to line-starts only — runner commands require
// :: at the beginning of a line. A global replace would mangle IPv6 addresses,
// C++/Rust/Ruby scope-resolution operators, and other legitimate :: usage.
// Safe to apply unconditionally — normal log text is unaffected.
function sanitizeForRunner(s: string): string {
  return s
    .replace(/##\[/g, '#[')
    .replace(/(^|[\r\n])::/gm, '$1: :')
}

async function run(): Promise<void> {
  try {
    core.info('=== local-ai-code-review-action starting ===')

    const config = readConfig()
    const context = await resolveReviewContext(config)

    if (context.skipReason) {
      core.info(context.skipReason)
      return
    }

    core.info('[step 1/5] Ensuring local-ai-cli binary...')
    const bin = await ensureBinary(config.token)
    core.info(`[step 1/5] Binary ready: ${bin}`)

    const result = await runReviewInference({
      bin,
      files: context.files,
      prNumber: context.prNumber,
      prTitle: context.prTitle,
      config,
    })

    if (!result.markdown) {
      core.info('[step 3/5] No patchable diff content — skipping review.')
      return
    }

    await publishReview({ result, context, config })

    core.info('=== local-ai-code-review-action done ===')
  } catch (error) {
    core.setFailed(sanitizeForRunner(error instanceof Error ? error.message : String(error)))
  }
}

run()
