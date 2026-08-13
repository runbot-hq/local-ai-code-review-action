export type ReviewScope = 'head-commit' | 'pull-request'

export function reviewScopeForAction(
  eventAction: string | undefined,
  alwaysReviewEntirePR = false
): ReviewScope {
  if (alwaysReviewEntirePR) return 'pull-request'
  return eventAction === 'synchronize' ? 'head-commit' : 'pull-request'
}

export function parseAlwaysReviewEntirePR(
  rawValue: string
): boolean | undefined {
  const normalized = rawValue.trim().toLowerCase()
  if (!normalized || normalized === 'false') return false
  if (normalized === 'true') return true
  return undefined
}
