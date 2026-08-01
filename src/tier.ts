import * as path from 'path'
import { NON_CODE_PATTERNS } from './constants'

export type Tier = 'shallow' | 'deep'

export function isNonCode(filename: string): boolean {
  const base = path.basename(filename)
  return NON_CODE_PATTERNS.some(p => p.test(base))
}

export function selectTier(files: Array<{ filename: string; additions: number; deletions: number }>): { tier: Tier; reviewableLines: number } {
  const SHALLOW_THRESHOLD = 150
  const reviewableLines = files
    .filter(f => !isNonCode(f.filename))
    .reduce((sum, f) => sum + f.additions + f.deletions, 0)
  const tier: Tier = reviewableLines >= SHALLOW_THRESHOLD ? 'deep' : 'shallow'
  return { tier, reviewableLines }
}
