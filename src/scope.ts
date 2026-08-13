export type ReviewScope = 'head-commit' | 'pull-request'

export function reviewScopeForAction(eventAction: string | undefined): ReviewScope {
  return eventAction === 'synchronize' ? 'head-commit' : 'pull-request'
}
