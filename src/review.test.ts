// Focused tests for buildReviewSchema (issue #70).
//
// Covers:
//   - buildReviewSchema(n) sets files.maxItems to n
//   - Existing REVIEW_SCHEMA fields are preserved unchanged
//   - REVIEW_SCHEMA itself is not mutated
//   - The returned schema is a fresh object each call
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { REVIEW_SCHEMA, buildReviewSchema } from './review'

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
// buildDiffBlock logic — pure re-implementation for isolation
// ---------------------------------------------------------------------------
//
// buildDiffBlock lives inside run() as a closure over `files` and is not
// directly importable. The tests below re-implement the same pure logic in
// isolation so the counting rules can be verified without spawning the full
// action. Any change to buildDiffBlock in index.ts must stay consistent with
// the behaviour documented here.

type PatchFile = { filename: string; status: string; patch?: string | null }

function buildDiffBlockPure(
  files: PatchFile[],
  maxChars: number
): { diffBlock: string; truncated: boolean; includedFileCount: number } {
  let diffBlock = ''
  let truncated = false
  let includedFileCount = 0
  for (const f of files) {
    if (!f.patch) continue
    const chunk =
      `### ${f.filename} (${f.status})\n` +
      `\`\`\`diff\n${f.patch}\n\`\`\`\n\n`
    if ((diffBlock + chunk).length > maxChars) {
      truncated = true
      break
    }
    diffBlock += chunk
    includedFileCount += 1
  }
  return { diffBlock, truncated, includedFileCount }
}

test('files without a patch do not increase includedFileCount', () => {
  const files: PatchFile[] = [
    { filename: 'a.ts', status: 'modified', patch: null },
    { filename: 'b.ts', status: 'modified', patch: undefined },
    { filename: 'c.ts', status: 'modified', patch: 'console.log(1)' },
  ]
  const { includedFileCount } = buildDiffBlockPure(files, 100_000)
  assert.equal(includedFileCount, 1)
})

test('a file that exceeds maxChars does not increase includedFileCount', () => {
  const files: PatchFile[] = [
    { filename: 'big.ts', status: 'modified', patch: 'x'.repeat(500) },
  ]
  const { includedFileCount, truncated } = buildDiffBlockPure(files, 10)
  assert.equal(includedFileCount, 0)
  assert.equal(truncated, true)
})

test('three-file prompt produces includedFileCount of 3 (issue #68 scenario)', () => {
  const files: PatchFile[] = [
    { filename: 'A.swift', status: 'modified', patch: '+let a = 1' },
    { filename: 'B.swift', status: 'modified', patch: '+let b = 2' },
    { filename: 'C.swift', status: 'modified', patch: '+let c = 3' },
  ]
  const { includedFileCount } = buildDiffBlockPure(files, 100_000)
  assert.equal(includedFileCount, 3)
})

test('initial format uses initial file count', () => {
  const files: PatchFile[] = [
    { filename: 'A.swift', status: 'modified', patch: '+let a = 1' },
    { filename: 'B.swift', status: 'modified', patch: '+let b = 2' },
  ]
  const { includedFileCount } = buildDiffBlockPure(files, 100_000)
  const schema = buildReviewSchema(includedFileCount)
  assert.equal(schema.properties.files.maxItems, 2)
})

test('reduced retry uses reduced prompt file count', () => {
  const patch = '+let x = ' + 'y'.repeat(300)
  const files: PatchFile[] = [
    { filename: 'A.swift', status: 'modified', patch },
    { filename: 'B.swift', status: 'modified', patch },
    { filename: 'C.swift', status: 'modified', patch },
  ]
  const initial = buildDiffBlockPure(files, 100_000)
  assert.equal(initial.includedFileCount, 3)

  const retryLimit = Math.floor(initial.diffBlock.length / 2)
  const reduced = buildDiffBlockPure(files, retryLimit)
  // Reduced diff fits fewer files — confirm count is less
  assert.ok(reduced.includedFileCount < initial.includedFileCount)

  const retrySchema = buildReviewSchema(reduced.includedFileCount)
  assert.equal(retrySchema.properties.files.maxItems, reduced.includedFileCount)
})

test('full-diff fallback uses original includedFileCount when reduced diff is empty', () => {
  // Simulate a single very large file: reduced limit = 0 files fit
  const patch = 'x'.repeat(1000)
  const files: PatchFile[] = [
    { filename: 'Large.swift', status: 'modified', patch },
  ]
  const initial = buildDiffBlockPure(files, 100_000)
  assert.equal(initial.includedFileCount, 1)

  const retryLimit = Math.floor(initial.diffBlock.length / 2)
  const reduced = buildDiffBlockPure(files, retryLimit)
  // Nothing fits in half the budget
  const usedFullDiffFallback = reduced.diffBlock.length === 0
  const retryFileCount = usedFullDiffFallback ? initial.includedFileCount : reduced.includedFileCount

  assert.equal(usedFullDiffFallback, true)
  assert.equal(retryFileCount, initial.includedFileCount)

  const retrySchema = buildReviewSchema(retryFileCount)
  assert.equal(retrySchema.properties.files.maxItems, 1)
})
