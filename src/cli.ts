import * as core from '@actions/core'
import { spawnSync } from 'child_process'

// IMPORTANT: Do NOT refactor localAiCli to use execSync.
// spawnSync passes argv directly to the OS without a shell interpreter.
// execSync runs via /bin/sh — any shell metacharacter in the prompt or
// instructions (backticks, $(), quotes, semicolons, etc.) would be executed.
// spawnSync eliminates that entire attack surface. This is intentional.
export function localAiCli(bin: string, prompt: string, options?: {
  instructions?: string
  model?: string
  baseUrl?: string
  temperature?: number
  maximumResponseTokens?: number
  numCtx?: number
  repeatPenalty?: number
  format?: string
  timeoutSeconds?: number
  think?: boolean
}): string {
  const timeoutSeconds = options?.timeoutSeconds ?? 600
  const args: string[] = ['--prompt', prompt]

  if (options?.instructions) args.push('--instructions', options.instructions)
  if (options?.model)        args.push('--model', options.model)
  if (options?.baseUrl)      args.push('--base-url', options.baseUrl)
  if (options?.temperature !== undefined) args.push('--temperature', String(options.temperature))
  if (options?.maximumResponseTokens !== undefined) args.push('--maximum-response-tokens', String(options.maximumResponseTokens))
  if (options?.numCtx !== undefined) args.push('--num-ctx', String(options.numCtx))
  if (options?.repeatPenalty !== undefined) args.push('--repeat-penalty', String(options.repeatPenalty))
  // format is a pre-serialized JSON string (either '"json"'-style bare word
  // or a full JSON Schema object string) — passed through opaquely to
  // local-ai-cli's --format flag, which itself passes it through opaquely to
  // Ollama. This action owns the schema; local-ai-cli owns nothing about it.
  if (options?.format !== undefined) args.push('--format', options.format)
  args.push('--timeout', String(timeoutSeconds))
  args.push('--think', options?.think ? 'true' : 'false')

  core.info(`[cli] Invoking binary: ${bin}`)
  core.info(`[cli] Args (excl prompt/instructions): model=${options?.model} base-url=${options?.baseUrl} temperature=${options?.temperature} max-tokens=${options?.maximumResponseTokens} num-ctx=${options?.numCtx} repeat-penalty=${options?.repeatPenalty} format=${options?.format !== undefined ? 'set' : 'unset'} timeout=${timeoutSeconds}s think=${options?.think ?? false}`)
  if (core.isDebug()) {
    core.debug(`[cli] Full spawnSync args: ${args.map(a => JSON.stringify(a)).join(' ')}`)
  }

  const spawnTimeoutMs = (timeoutSeconds + 60) * 1000
  core.info(`[cli] spawnSync hard-kill timeout: ${spawnTimeoutMs / 1000}s`)

  const callStart = Date.now()
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: spawnTimeoutMs,
    // 10 MB buffer — model output for large PRs can be verbose. Raises an
    // error rather than silently truncating if the limit is ever exceeded.
    maxBuffer: 10 * 1024 * 1024,
  })
  const callMs = Date.now() - callStart
  core.info(`[cli] spawnSync returned in ${callMs}ms, exit code: ${result.status}`)

  if (result.error) {
    core.error(`[cli] spawnSync error: ${result.error}`)
    throw result.error
  }
  if (result.stderr) {
    core.info(`[cli] stderr: ${result.stderr.trim()}`)
  }
  if (result.status !== 0) {
    throw new Error(`local-ai-cli exited ${result.status}: ${result.stderr?.trim()}`)
  }

  const outputLen = result.stdout?.length ?? 0
  core.info(`[cli] stdout length: ${outputLen} chars`)
  return result.stdout.trim()
}

export function isFatalError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return (
    msg.includes('invalid --base-url') ||
    msg.includes('http 404') ||
    msg.includes('eacces') ||
    msg.includes('enoent')
  )
}

export function isEmptyThinkExhaust(e: unknown, think: boolean): boolean {
  if (!think) return false
  const msg = String(e)
  return (
    msg.includes('empty response') &&
    (msg.includes('done_reason=stop') || msg.includes('done_reason=length'))
  )
}
