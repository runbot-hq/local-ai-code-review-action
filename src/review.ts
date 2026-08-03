// Structured-output schema and rendering for AI code reviews.
//
// The model returns JSON matching REVIEW_SCHEMA (enforced by Ollama's
// structured-output feature via local-ai-cli's --format flag) instead of
// directly emitting Markdown. This action owns all Markdown formatting —
// the model's only job is to fill in file/issue data, which is far harder
// to drift away from into changelog/summary prose than free-form Markdown
// generation is.
//
// Ported from review_commit_2.sh's FORMAT=json jq schema + jq -r renderer.

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                line: { type: 'integer' },
                severity: { type: 'string', enum: ['critical', 'warning', 'suggestion'] },
                comment: { type: 'string' },
              },
              required: ['comment'],
            },
          },
        },
        required: ['filename', 'issues'],
      },
    },
  },
  required: ['files'],
} as const

export interface ReviewIssue {
  line?: number
  severity?: 'critical' | 'warning' | 'suggestion'
  comment: string
}

export interface ReviewFile {
  filename: string
  issues: ReviewIssue[]
}

export interface ParsedReview {
  files: ReviewFile[]
}

// Type-guards the shape just enough to render safely — does not do full
// JSON Schema validation (Ollama's structured-output feature already
// constrains the model's token sampling to match REVIEW_SCHEMA; this is a
// defensive check against a model that technically emits valid JSON but not
// the expected shape, e.g. an empty object `{}`).
//
// Issue entries are validated down to `comment` specifically because it is
// the only field marked `required` in REVIEW_SCHEMA's `issues.items` — line
// and severity are optional and already have `??` fallbacks in
// renderReviewMarkdown, but comment has no such fallback. Without this check,
// a model emitting e.g. `{}` as an issue entry (structurally possible even
// under structured-output enforcement of the outer shape) would render the
// literal string "undefined" into the posted PR comment.
//
// IMPORTANT: `comment` must be checked for non-empty content, not just
// typeof === 'string'. JSON Schema's `required` only guarantees the key is
// present — it does NOT guarantee a non-empty value. A model can (and in
// production did) satisfy the schema with `comment: ""`, which passed a
// typeof-only check and rendered as a blank bullet
// ("- Line 17: [suggestion] " with nothing after it). Trimming and checking
// .length catches this.
//
// NOTE: filename is intentionally NOT checked for non-empty content here.
// This function only validates the response is *structurally* safe to render
// (i.e. won't crash or emit literal "undefined") — filtering out semantically
// bogus entries (like a blank-filename file the model hallucinated to hold a
// non-finding) is the job of getRealFiles() below, applied uniformly at every
// call site instead of being baked into shape validation.
export function isParsedReview(value: unknown): value is ParsedReview {
  if (typeof value !== 'object' || value === null) return false
  const files = (value as Record<string, unknown>).files
  if (!Array.isArray(files)) return false
  return files.every((f) => {
    if (typeof f !== 'object' || f === null) return false
    const rec = f as Record<string, unknown>
    if (typeof rec.filename !== 'string' || !Array.isArray(rec.issues)) return false
    return (rec.issues as unknown[]).every((i) => {
      if (typeof i !== 'object' || i === null) return false
      const comment = (i as Record<string, unknown>).comment
      return typeof comment === 'string' && comment.trim().length > 0
    })
  })
}

// Filters out file entries with an empty/whitespace-only filename.
//
// Observed in production: the model can satisfy REVIEW_SCHEMA (filename is
// only typed as `string`, not required to be non-empty) by emitting a file
// entry with filename: "" whose "issues" list contains a non-finding dressed
// up as a finding, e.g. { comment: "The diff contains no security issues." }.
// This is the model's way of saying "nothing to report" for a category it
// was asked to consider, but it is not a real per-file review result — left
// unfiltered it renders as a redundant blank "### " block in the comment,
// and its non-empty issues array incorrectly defeats skip_comment_if_no_issues
// on an otherwise all-clear PR (see index.ts noIssuesFound).
//
// Applied uniformly by both renderReviewMarkdown and index.ts's noIssuesFound
// computation so the two can never disagree on what counts as a "real" file.
export function getRealFiles(review: ParsedReview): ReviewFile[] {
  return review.files.filter((f) => f.filename?.trim().length > 0)
}

// Mirrors the jq -r rendering block in review_commit_2.sh exactly:
//   - empty files[] → "✅ No issues found in this PR."
//   - per file: "### filename", then either "✅ No issues." (empty issues) or
//     "- [Line N: ][severity] comment" per issue, followed by a blank line.
//
// Issues with an empty/whitespace-only comment are filtered out defensively
// even though isParsedReview should already have rejected them upstream —
// this keeps renderReviewMarkdown safe to call directly (e.g. in tests)
// without relying on the caller to have validated first.
//
// Blank-filename file entries are dropped via getRealFiles() before checking
// review.files.length, so a response consisting entirely of hallucinated
// blank-filename entries still renders the all-clear message rather than a
// stray "### " block.
export function renderReviewMarkdown(review: ParsedReview): string {
  const realFiles = getRealFiles(review)
  if (realFiles.length === 0) {
    return '✅ No issues found in this PR.'
  }

  const blocks: string[] = []
  for (const file of realFiles) {
    const lines: string[] = [`### ${file.filename}`]
    const issues = file.issues.filter((issue) => issue.comment?.trim().length > 0)
    if (issues.length === 0) {
      lines.push('✅ No issues.')
    } else {
      for (const issue of issues) {
        const linePrefix = issue.line !== undefined ? `Line ${issue.line}: ` : ''
        const severity = issue.severity ?? 'suggestion'
        lines.push(`- ${linePrefix}[${severity}] ${issue.comment}`)
      }
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}
