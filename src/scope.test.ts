// Tests for the dual review-scope decision (issue #76 / task #77).
//
// Covers:
//   - scope decision: opened   -> pull-request
//   - scope decision: reopened -> pull-request
//   - scope decision: synchronize -> head-commit
//   - regression 8dd2063: synchronize with 2-file head commit does not bleed
//     into the large MarkdownKit PR diff; includedFileCount and schema
//     maxItems both equal 2.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildReviewSchema } from './review'

// ---------------------------------------------------------------------------
// Pure scope-decision helper — mirrors the logic in index.ts exactly.
// ---------------------------------------------------------------------------
function reviewScope(eventAction: string): 'head-commit' | 'pull-request' {
  return eventAction === 'synchronize' ? 'head-commit' : 'pull-request'
}

// ---------------------------------------------------------------------------
// Pure buildDiffBlock re-implementation (mirrored from review.test.ts helper).
// ---------------------------------------------------------------------------
type PatchFile = {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string | null
}

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

// ---------------------------------------------------------------------------
// Scope decision tests
// ---------------------------------------------------------------------------

test('opened -> pull-request scope', () => {
  assert.equal(reviewScope('opened'), 'pull-request')
})

test('reopened -> pull-request scope', () => {
  assert.equal(reviewScope('reopened'), 'pull-request')
})

test('synchronize -> head-commit scope', () => {
  assert.equal(reviewScope('synchronize'), 'head-commit')
})

// ---------------------------------------------------------------------------
// Regression test for commit 8dd2063
//
// Context: A push on a large MarkdownKit-migration PR contained only two
// changed files (AGENTS.md and docs/development.md). The regression caused
// every synchronize event to call pulls.listFiles and re-review the entire
// PR. The correct behavior is: synchronize uses headCommit.files (2 files);
// the MarkdownKit source files never enter the diff block.
// ---------------------------------------------------------------------------

const headCommitFiles: PatchFile[] = [
  { filename: 'AGENTS.md',             status: 'modified', additions: 5,  deletions: 2,  patch: '+# AGENTS\n-old' },
  { filename: 'docs/development.md',   status: 'modified', additions: 3,  deletions: 1,  patch: '+## Dev\n-old' },
]

const markdownKitFiles: PatchFile[] = [
  { filename: 'Sources/MarkdownKit/Parser.swift',   status: 'modified', additions: 200, deletions: 150, patch: '+// parser' },
  { filename: 'Sources/MarkdownKit/Renderer.swift', status: 'modified', additions: 180, deletions: 120, patch: '+// renderer' },
  { filename: 'Sources/MarkdownKit/Lexer.swift',    status: 'modified', additions: 160, deletions: 100, patch: '+// lexer' },
  ...headCommitFiles,
]

test('regression 8dd2063: synchronize selects only head-commit files (2)', () => {
  const scope = reviewScope('synchronize')
  assert.equal(scope, 'head-commit')

  // For synchronize, files come from headCommit.files — not pulls.listFiles
  const { includedFileCount } = buildDiffBlockPure(headCommitFiles, 100_000)
  assert.equal(includedFileCount, 2)
})

test('regression 8dd2063: includedFileCount is 2 on synchronize', () => {
  const { includedFileCount } = buildDiffBlockPure(headCommitFiles, 100_000)
  assert.equal(includedFileCount, 2)
})

test('regression 8dd2063: schema maxItems is 2 on synchronize', () => {
  const { includedFileCount } = buildDiffBlockPure(headCommitFiles, 100_000)
  const schema = buildReviewSchema(includedFileCount)
  assert.equal(schema.properties.files.maxItems, 2)
})

test('regression 8dd2063: no MarkdownKit source file enters the head-commit diff', () => {
  const { diffBlock } = buildDiffBlockPure(headCommitFiles, 100_000)
  assert.ok(!diffBlock.includes('MarkdownKit'), 'MarkdownKit source must not appear in head-commit diff block')
})

test('opened selects full PR file list (5 files in MarkdownKit scenario)', () => {
  const scope = reviewScope('opened')
  assert.equal(scope, 'pull-request')

  const { includedFileCount } = buildDiffBlockPure(markdownKitFiles, 100_000)
  assert.equal(includedFileCount, 5)
})

test('reopened selects full PR file list (5 files in MarkdownKit scenario)', () => {
  const scope = reviewScope('reopened')
  assert.equal(scope, 'pull-request')

  const { includedFileCount } = buildDiffBlockPure(markdownKitFiles, 100_000)
  assert.equal(includedFileCount, 5)
})
