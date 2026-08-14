// LEGACY_BOT_SIGNATURE_SEARCH_KEY is kept for backward compatibility only.
// It identifies comments posted before the visible title was introduced.
// Do NOT use it as the primary deduplication key — footer wording is
// presentation and will likely change again. Keep for at least one release
// so replace_existing_comment can still clean up pre-title comments.
export const LEGACY_BOT_SIGNATURE_SEARCH_KEY = 'AI code review by github.com/runbot-hq/run-bot'
export const BOT_SIGNATURE = `\n\n---\nReview by [RunBot](https://github.com/runbot-hq/run-bot)`

// Visible heading prepended to every rendered review.
// Primary deduplication key: new comments are identified by startsWith(REVIEW_TITLE).
// Kept as a constant so rendering and tests share one canonical definition.
export const REVIEW_TITLE = '## 🤖 RunBot Review'

// File extensions/names that carry no reviewable logic — excluded from the
// reviewable-lines count used to select shallow vs deep review tier.
export const NON_CODE_PATTERNS = [
  /\.md$/i,
  /\.lock$/i,
  /\.json$/i,
  /\.yml$/i,
  /\.yaml$/i,
  /^package-lock\.json$/i,
]
