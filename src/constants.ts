// BOT_SIGNATURE_SEARCH_KEY and BOT_SIGNATURE are intentionally separate.
// SEARCH_KEY is plain text used to scan existing comments (no Markdown syntax
// so it can be matched reliably with String.includes()).
// BOT_SIGNATURE is the full Markdown footer appended to posted reviews.
// Do NOT merge them — if the footer text ever changes, search would break
// for comments posted under the old format.
export const BOT_SIGNATURE_SEARCH_KEY = 'AI code review by github.com/runbot-hq/run-bot'
export const BOT_SIGNATURE = `\n\n---\n> 🤖 [${BOT_SIGNATURE_SEARCH_KEY}](https://github.com/runbot-hq/run-bot)`

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
