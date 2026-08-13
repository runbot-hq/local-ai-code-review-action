export type ReviewScope = 'head-commit' | 'pull-request'

export function reviewScopeForAction(
  eventAction: string | undefined,
  alwaysReviewEntirePR = false
): ReviewScope {
  if (alwaysReviewEntirePR) return 'pull-request'
  return eventAction === 'synchronize' ? 'head-commit' : 'pull-request'
}
