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
export function isParsedReview(value: unknown): value is ParsedReview {
  if (typeof value !== 'object' || value === null) return false
  const files = (value as Record<string, unknown>).files
  if (!Array.isArray(files)) return false
  return files.every((f) => {
    if (typeof f !== 'object' || f === null) return false
    const rec = f as Record<string, unknown>
    return typeof rec.filename === 'string' && Array.isArray(rec.issues)
  })
}

// Mirrors the jq -r rendering block in review_commit_2.sh exactly:
//   - empty files[] → "✅ No issues found in this PR."
//   - per file: "### filename", then either "✅ No issues." (empty issues) or
//     "- [Line N: ][severity] comment" per issue, followed by a blank line.
export function renderReviewMarkdown(review: ParsedReview): string {
  if (review.files.length === 0) {
    return '✅ No issues found in this PR.'
  }

  const blocks: string[] = []
  for (const file of review.files) {
    const lines: string[] = [`### ${file.filename}`]
    if (file.issues.length === 0) {
      lines.push('✅ No issues.')
    } else {
      for (const issue of file.issues) {
        const linePrefix = issue.line !== undefined ? `Line ${issue.line}: ` : ''
        const severity = issue.severity ?? 'suggestion'
        lines.push(`- ${linePrefix}[${severity}] ${issue.comment}`)
      }
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}
