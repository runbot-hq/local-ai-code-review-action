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

import { REVIEW_TITLE } from './constants'

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
                comment: { type: 'string', minLength: 1 },
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

// Returns a copy of REVIEW_SCHEMA with files.maxItems set to maxFiles.
// Used to bound the top-level files[] array to the number of complete file
// chunks included in the prompt, preventing the model from emitting the same
// valid file object repeatedly until the response reaches the output-token
// limit and becomes truncated JSON.
//
// Do not mutate the exported REVIEW_SCHEMA constant — always construct a new
// object so callers that read REVIEW_SCHEMA directly are unaffected.
export function buildReviewSchema(maxFiles: number) {
  return {
    ...REVIEW_SCHEMA,
    properties: {
      ...REVIEW_SCHEMA.properties,
      files: {
        ...REVIEW_SCHEMA.properties.files,
        maxItems: maxFiles,
      },
    },
  } as const
}

// Applied uniformly by both renderReviewMarkdown and index.ts's noIssuesFound
// computation so the two can never disagree on what counts as a "real" file.
//
// Coalesces repeated file entries and deduplicates issues within each file:
//   - Drops entries with blank filenames.
//   - Groups entries by trimmed filename, preserving first-seen file order.
//   - Merges issues from repeated file entries.
//   - Deduplicates issues within each file, preserving first-seen issue order.
//   - An issue is a duplicate when its rendered values are equal:
//     line + effective severity + trimmed comment.
//   - Missing severity is treated as "suggestion" (matching the renderer).
//   - Does not deduplicate across different filenames.
//   - Does not mutate the input ParsedReview.
export function getRealFiles(review: ParsedReview): ReviewFile[] {
  const result: ReviewFile[] = []

  const entries = new Map<
    string,
    {
      file: ReviewFile
      issueKeys: Set<string>
    }
  >()

  for (const candidate of review.files) {
    const filename = candidate.filename.trim()
    if (!filename) continue

    let entry = entries.get(filename)

    if (!entry) {
      entry = {
        file: {
          filename,
          issues: [],
        },
        issueKeys: new Set<string>(),
      }

      entries.set(filename, entry)
      result.push(entry.file)
    }

    for (const issue of candidate.issues) {
      const comment = issue.comment.trim()
      if (!comment) continue

      const effectiveSeverity = issue.severity ?? 'suggestion'
      const key = JSON.stringify([
        issue.line ?? null,
        effectiveSeverity,
        comment,
      ])

      if (entry.issueKeys.has(key)) continue
      entry.issueKeys.add(key)

      entry.file.issues.push({
        ...issue,
        comment,
      })
    }
  }

  return result
}

// Derived from the jq -r rendering block in review_commit_2.sh, with the
// per-file "✅ No issues." sections intentionally omitted (see #99).
//   - empty files[] → "✅ No issues found in this PR."
//   - per file: "### filename", then "- [Line N: ][severity] comment" per issue.
//     Sections without renderable issues are omitted entirely (no "✅ No issues."
//     per-file block is emitted).
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
// Wraps any review body string with the canonical marker and title that
// every posted PR comment must begin with. Keeping this in the renderer
// (rather than in posting.ts) ensures the PR comment, review_body output,
// review_file artifact and any direct renderReviewMarkdown callers all
// share the same canonical structure.
function wrapReviewBody(body: string): string {
  return [REVIEW_TITLE, '', body].join('\n')
}

export function renderReviewMarkdown(review: ParsedReview): string {
  const realFiles = getRealFiles(review)

  const blocks: string[] = []
  for (const file of realFiles) {
    const issues = file.issues.filter((issue) => issue.comment?.trim().length > 0)
    // Do not emit a review section without review content.
    if (issues.length === 0) continue

    const lines: string[] = [`### ${file.filename}`]
    for (const issue of issues) {
      const linePrefix = issue.line !== undefined ? `Line ${issue.line}: ` : ''
      const severity = issue.severity ?? 'suggestion'
      lines.push(`- ${linePrefix}[${severity}] ${issue.comment}`)
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.length > 0
    ? wrapReviewBody(blocks.join('\n\n'))
    : wrapReviewBody('✅ No issues found in this PR.')
}
