// BOT_SIGNATURE_SEARCH_KEY and BOT_SIGNATURE are intentionally separate.
// SEARCH_KEY is plain text used to scan existing comments (no Markdown syntax
// so it can be matched reliably with String.includes()).
// BOT_SIGNATURE is the full Markdown footer appended to posted reviews.
// Do NOT merge them — if the footer text ever changes, search would break
// for comments posted under the old format.
export const BOT_SIGNATURE_SEARCH_KEY = 'AI code review by github.com/runbot-hq/run-bot'
export const BOT_SIGNATURE = `\n\n---\n> 🤖 [${BOT_SIGNATURE_SEARCH_KEY}](https://github.com/runbot-hq/run-bot)`

// REVIEW_COMMENT_MARKER is the hidden HTML comment placed at the very top of
// every review comment so the action can reliably identify and replace its own
// previous comments without false-positive matching on user comments.
// REVIEW_TITLE is the human-visible heading that immediately follows the marker.
// Both are kept here (not in the renderer) so posting.ts, review.ts and tests
// all share one canonical definition.
export const REVIEW_COMMENT_MARKER = '<!-- runbot-review-summary-comment -->'
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
