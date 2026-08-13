// Focused tests for buildReviewSchema (issue #70).
//
// Covers:
//   - buildReviewSchema(n) sets files.maxItems to n
//   - Existing REVIEW_SCHEMA fields are preserved unchanged
//   - REVIEW_SCHEMA itself is not mutated
//   - The returned schema is a fresh object each call
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { REVIEW_SCHEMA, buildReviewSchema, getRealFiles, renderReviewMarkdown } from './review'
import { REVIEW_COMMENT_MARKER, REVIEW_TITLE } from './constants'
import type { ParsedReview, ReviewFile } from './review'
import { buildDiffBlock } from './diff'
import type { ChangedFile } from './diff'

test('buildReviewSchema sets files.maxItems to the supplied count', () => {
  const schema = buildReviewSchema(3)
  assert.equal(schema.properties.files.maxItems, 3)
})

test('buildReviewSchema(0) sets maxItems to 0', () => {
  const schema = buildReviewSchema(0)
  assert.equal(schema.properties.files.maxItems, 0)
})

test('buildReviewSchema preserves files.type', () => {
  const schema = buildReviewSchema(5)
  assert.equal(schema.properties.files.type, REVIEW_SCHEMA.properties.files.type)
})

test('buildReviewSchema preserves files.items shape', () => {
  const schema = buildReviewSchema(2)
  assert.deepEqual(
    schema.properties.files.items,
    REVIEW_SCHEMA.properties.files.items
  )
})

test('buildReviewSchema preserves top-level required', () => {
  const schema = buildReviewSchema(1)
  assert.deepEqual(schema.required, REVIEW_SCHEMA.required)
})

test('REVIEW_SCHEMA is not mutated by buildReviewSchema', () => {
  const before = JSON.stringify(REVIEW_SCHEMA)
  buildReviewSchema(7)
  assert.equal(JSON.stringify(REVIEW_SCHEMA), before)
})

test('buildReviewSchema returns a new object on each call', () => {
  const a = buildReviewSchema(2)
  const b = buildReviewSchema(2)
  assert.notEqual(a, b)
  assert.notEqual(a.properties.files, b.properties.files)
})

test('two calls with different counts produce independent maxItems', () => {
  const s3 = buildReviewSchema(3)
  const s5 = buildReviewSchema(5)
  assert.equal(s3.properties.files.maxItems, 3)
  assert.equal(s5.properties.files.maxItems, 5)
})

// ---------------------------------------------------------------------------
// buildDiffBlock — exercises the production implementation from diff.ts
// ---------------------------------------------------------------------------

test('files without a patch do not increase includedFileCount', () => {
  const files: ChangedFile[] = [
    { filename: 'a.ts', status: 'modified', additions: 0, deletions: 0, patch: undefined },
    { filename: 'b.ts', status: 'modified', additions: 0, deletions: 0, patch: undefined },
    { filename: 'c.ts', status: 'modified', additions: 0, deletions: 0, patch: 'console.log(1)' },
  ]
  const { includedFileCount } = buildDiffBlock(files, 100_000)
  assert.equal(includedFileCount, 1)
})

test('a file that exceeds maxChars does not increase includedFileCount', () => {
  const files: ChangedFile[] = [
    { filename: 'big.ts', status: 'modified', additions: 0, deletions: 0, patch: 'x'.repeat(500) },
  ]
  const { includedFileCount, truncated } = buildDiffBlock(files, 10)
  assert.equal(includedFileCount, 0)
  assert.equal(truncated, true)
})

test('three-file prompt produces includedFileCount of 3 (issue #68 scenario)', () => {
  const files: ChangedFile[] = [
    { filename: 'A.swift', status: 'modified', additions: 0, deletions: 0, patch: '+let a = 1' },
    { filename: 'B.swift', status: 'modified', additions: 0, deletions: 0, patch: '+let b = 2' },
    { filename: 'C.swift', status: 'modified', additions: 0, deletions: 0, patch: '+let c = 3' },
  ]
  const { includedFileCount } = buildDiffBlock(files, 100_000)
  assert.equal(includedFileCount, 3)
})

test('initial format uses initial file count', () => {
  const files: ChangedFile[] = [
    { filename: 'A.swift', status: 'modified', additions: 0, deletions: 0, patch: '+let a = 1' },
    { filename: 'B.swift', status: 'modified', additions: 0, deletions: 0, patch: '+let b = 2' },
  ]
  const { includedFileCount } = buildDiffBlock(files, 100_000)
  const schema = buildReviewSchema(includedFileCount)
  assert.equal(schema.properties.files.maxItems, 2)
})

test('reduced retry uses reduced prompt file count', () => {
  const patch = '+let x = ' + 'y'.repeat(300)
  const files: ChangedFile[] = [
    { filename: 'A.swift', status: 'modified', additions: 0, deletions: 0, patch },
    { filename: 'B.swift', status: 'modified', additions: 0, deletions: 0, patch },
    { filename: 'C.swift', status: 'modified', additions: 0, deletions: 0, patch },
  ]
  const initial = buildDiffBlock(files, 100_000)
  assert.equal(initial.includedFileCount, 3)

  const retryLimit = Math.floor(initial.diffBlock.length / 2)
  const reduced = buildDiffBlock(files, retryLimit)
  // Reduced diff fits fewer files — confirm count is less
  assert.ok(reduced.includedFileCount < initial.includedFileCount)

  const retrySchema = buildReviewSchema(reduced.includedFileCount)
  assert.equal(retrySchema.properties.files.maxItems, reduced.includedFileCount)
})

test('full-diff fallback uses original includedFileCount when reduced diff is empty', () => {
  // Simulate a single very large file: reduced limit = 0 files fit
  const patch = 'x'.repeat(1000)
  const files: ChangedFile[] = [
    { filename: 'Large.swift', status: 'modified', additions: 0, deletions: 0, patch },
  ]
  const initial = buildDiffBlock(files, 100_000)
  assert.equal(initial.includedFileCount, 1)

  const retryLimit = Math.floor(initial.diffBlock.length / 2)
  const reduced = buildDiffBlock(files, retryLimit)
  // Nothing fits in half the budget
  const usedFullDiffFallback = reduced.diffBlock.length === 0
  const retryFileCount = usedFullDiffFallback ? initial.includedFileCount : reduced.includedFileCount

  assert.equal(usedFullDiffFallback, true)
  assert.equal(retryFileCount, initial.includedFileCount)

  const retrySchema = buildReviewSchema(retryFileCount)
  assert.equal(retrySchema.properties.files.maxItems, 1)
})

// ---------------------------------------------------------------------------
// getRealFiles — deduplication and coalescing (issue #73)
// ---------------------------------------------------------------------------

test('getRealFiles: repeated filename entries produce one ReviewFile', () => {
  const review: ParsedReview = {
    files: [
      { filename: 'a.ts', issues: [{ comment: 'foo' }] },
      { filename: 'a.ts', issues: [{ comment: 'bar' }] },
    ],
  }
  const result = getRealFiles(review)
  assert.equal(result.length, 1)
  assert.equal(result[0].filename, 'a.ts')
})

test('getRealFiles: a clean entry followed by an entry with issues produces one file containing the issues', () => {
  const review: ParsedReview = {
    files: [
      { filename: 'a.ts', issues: [] },
      { filename: 'a.ts', issues: [{ comment: 'found it' }] },
    ],
  }
  const result = getRealFiles(review)
  assert.equal(result.length, 1)
  assert.equal(result[0].issues.length, 1)
  assert.equal(result[0].issues[0].comment, 'found it')
})

test('getRealFiles: identical repeated issues produce one issue', () => {
  const review: ParsedReview = {
    files: [
      { filename: 'a.ts', issues: [{ comment: 'same' }] },
      { filename: 'a.ts', issues: [{ comment: 'same' }] },
    ],
  }
  const result = getRealFiles(review)
  assert.equal(result.length, 1)
  assert.equal(result[0].issues.length, 1)
  assert.equal(result[0].issues[0].comment, 'same')
})

test('getRealFiles: distinct issues for the same file are preserved', () => {
  const review: ParsedReview = {
    files: [
      { filename: 'a.ts', issues: [{ comment: 'first' }, { comment: 'second' }] },
    ],
  }
  const result = getRealFiles(review)
  assert.equal(result.length, 1)
  assert.equal(result[0].issues.length, 2)
})

test('getRealFiles: same comment with different line numbers is preserved as separate findings', () => {
  const review: ParsedReview = {
    files: [
      { filename: 'a.ts', issues: [{ line: 1, comment: 'same' }, { line: 2, comment: 'same' }] },
    ],
  }
  const result = getRealFiles(review)
  assert.equal(result.length, 1)
  assert.equal(result[0].issues.length, 2)
})

test('getRealFiles: same comment and line with different severities is preserved', () => {
  const review: ParsedReview = {
    files: [
      { filename: 'a.ts', issues: [{ line: 5, severity: 'warning', comment: 'hello' }, { line: 5, severity: 'critical', comment: 'hello' }] },
    ],
  }
  const result = getRealFiles(review)
  assert.equal(result.length, 1)
  assert.equal(result[0].issues.length, 2)
})

test('getRealFiles: missing severity and explicit suggestion deduplicate as equivalent', () => {
  const review: ParsedReview = {
    files: [
      { filename: 'a.ts', issues: [{ comment: 'same' }, { severity: 'suggestion', comment: 'same' }] },
    ],
  }
  const result = getRealFiles(review)
  assert.equal(result.length, 1)
  assert.equal(result[0].issues.length, 1)
})

test('getRealFiles: leading/trailing comment whitespace does not defeat deduplication', () => {
  const review: ParsedReview = {
    files: [
      { filename: 'a.ts', issues: [{ comment: '  hello world  ' }] },
      { filename: 'a.ts', issues: [{ comment: 'hello world' }] },
    ],
  }
  const result = getRealFiles(review)
  assert.equal(result.length, 1)
  assert.equal(result[0].issues.length, 1)
  assert.equal(result[0].issues[0].comment, 'hello world')
})

test('getRealFiles: blank filenames are dropped', () => {
  const review: ParsedReview = {
    files: [
      { filename: '', issues: [{ comment: 'should not appear' }] },
      { filename: '  ', issues: [{ comment: 'should not appear either' }] },
      { filename: 'real.ts', issues: [{ comment: 'real' }] },
    ],
  }
  const result = getRealFiles(review)
  assert.equal(result.length, 1)
  assert.equal(result[0].filename, 'real.ts')
})

test('getRealFiles: first-seen file and issue ordering is preserved', () => {
  const review: ParsedReview = {
    files: [
      { filename: 'b.ts', issues: [{ comment: 'B first' }] },
      { filename: 'z.ts', issues: [{ comment: 'Z first' }] },
      { filename: 'a.ts', issues: [{ comment: 'A first' }] },
      { filename: 'b.ts', issues: [{ comment: 'B second' }] },
    ],
  }
  const result = getRealFiles(review)
  assert.equal(result.length, 3)
  assert.equal(result[0].filename, 'b.ts')
  assert.equal(result[1].filename, 'z.ts')
  assert.equal(result[2].filename, 'a.ts')
  assert.equal(result[0].issues[0].comment, 'B first')
  assert.equal(result[0].issues[1].comment, 'B second')
})

test('getRealFiles: the input ParsedReview is not mutated', () => {
  const original: ParsedReview = {
    files: [
      { filename: 'a.ts', issues: [{ comment: 'before' }] },
      { filename: 'a.ts', issues: [{ comment: 'after' }] },
    ],
  }
  const originalJson = JSON.stringify(original)
  getRealFiles(original)
  assert.equal(JSON.stringify(original), originalJson)
})

test('renderReviewMarkdown: emits one header and one bullet for the #73 repetition case', () => {
  const review: ParsedReview = {
    files: [
      { filename: 'app.ts', issues: [{ line: 10, severity: 'warning', comment: 'Use const' }] },
      { filename: 'app.ts', issues: [{ line: 10, severity: 'warning', comment: 'Use const' }] },
    ],
  }
  const md = renderReviewMarkdown(review)
  // Should have exactly one "### app.ts" header and one bullet.
  // Use /^- /m (start-of-line bullet) to avoid matching "- " inside the
  // HTML marker comment (<!-- runbot-review-summary-comment -->).
  const headerMatches = md.match(/### app\.ts/g)
  assert.equal(headerMatches?.length, 1)
  const bulletMatches = md.match(/^- /gm)
  assert.equal(bulletMatches?.length, 1)
})

test('renderReviewMarkdown adds marker and title as exact prefix with blank line', () => {
  const review: ParsedReview = {
    files: [
      {
        filename: 'src/app.ts',
        issues: [{ comment: 'Use const.' }],
      },
    ],
  }
  const markdown = renderReviewMarkdown(review)
  // Two trailing '\n' entries produce the required blank line between title and body.
  const expectedPrefix = [REVIEW_COMMENT_MARKER, REVIEW_TITLE, '', ''].join('\n')
  assert.ok(
    markdown.startsWith(expectedPrefix),
    `Expected blank line after title, got: ${JSON.stringify(markdown.slice(0, 120))}`
  )
})

test('renderReviewMarkdown emits marker and title exactly once', () => {
  const review: ParsedReview = {
    files: [
      { filename: 'a.ts', issues: [{ comment: 'First' }] },
      { filename: 'b.ts', issues: [{ comment: 'Second' }] },
    ],
  }
  const markdown = renderReviewMarkdown(review)
  assert.equal(
    markdown.match(new RegExp(REVIEW_COMMENT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length,
    1,
    'REVIEW_COMMENT_MARKER must appear exactly once'
  )
  assert.equal(
    markdown.match(/^## 🤖 RunBot Review$/gm)?.length,
    1,
    'REVIEW_TITLE must appear exactly once'
  )
})

test('renderReviewMarkdown no-issues case emits exact full output', () => {
  const review: ParsedReview = { files: [] }
  const markdown = renderReviewMarkdown(review)
  assert.equal(
    markdown,
    [REVIEW_COMMENT_MARKER, REVIEW_TITLE, '', '✅ No issues found in this PR.'].join('\n'),
    'No-issues output must match canonical marker+title+blank+body exactly'
  )
})
