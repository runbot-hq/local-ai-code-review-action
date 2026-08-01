import * as core from '@actions/core'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { httpsGetJson, httpsDownload, sha256File } from './http'

export async function ensureBinary(token: string): Promise<string> {
  const cacheDir = path.join(os.homedir(), '.cache', 'runbot-hq')
  const binPath = path.join(cacheDir, 'local-ai-cli-bin')
  const digestPath = path.join(cacheDir, 'local-ai-cli-bin.digest')

  core.info(`[binary] Cache dir: ${cacheDir}`)
  core.info(`[binary] Bin path:  ${binPath}`)
  core.info(`[binary] Checking latest runbot-hq/local-ai-cli release...`)

  const release = await httpsGetJson('https://api.github.com/repos/runbot-hq/local-ai-cli/releases/latest', token)
  const tagName = release.tag_name as string ?? 'unknown'
  const publishedAt = release.published_at as string ?? ''
  core.info(`[binary] Latest release tag: ${tagName} published_at: ${publishedAt}`)

  const asset = (release.assets as Array<{ name: string; browser_download_url: string; digest?: string; updated_at?: string }>)
    .find((a) => a.name === 'local-ai-cli-bin')
  if (!asset) {
    const assetNames = (release.assets as Array<{ name: string }>).map(a => a.name).join(', ')
    throw new Error(
      `local-ai-cli-bin asset not found in release ${tagName} of runbot-hq/local-ai-cli. ` +
      `Available assets: [${assetNames}]`
    )
  }
  core.info(`[binary] Found asset: ${asset.name} (${asset.browser_download_url})`)

  const remoteDigest: string = asset.digest ?? ''
  const cacheKey: string = remoteDigest || `updated_at:${asset.updated_at ?? publishedAt ?? tagName}`
  core.info(`[binary] Remote digest: ${remoteDigest || '(none — using updated_at as cache key)'}`)
  core.info(`[binary] Cache key: ${cacheKey}`)

  const binExists = fs.existsSync(binPath)
  const digestExists = fs.existsSync(digestPath)
  core.info(`[binary] Cache state: bin=${binExists}, digest=${digestExists}`)

  if (binExists && digestExists) {
    const cachedKey = fs.readFileSync(digestPath, 'utf8').trim()
    core.info(`[binary] Cached key: ${cachedKey}`)
    if (cachedKey === cacheKey) {
      const binSize = fs.statSync(binPath).size
      core.info(`[binary] Cache hit ✔ — skipping download (size: ${binSize} bytes)`)
      return binPath
    }
    core.info(`[binary] Cache stale — re-downloading`)
  } else {
    core.info(`[binary] No cached binary — downloading for the first time`)
  }

  fs.mkdirSync(cacheDir, { recursive: true })
  core.info(`[binary] Downloading ${asset.browser_download_url} ...`)
  const downloadStart = Date.now()
  await httpsDownload(asset.browser_download_url, binPath)
  const downloadMs = Date.now() - downloadStart
  const binSize = fs.statSync(binPath).size
  core.info(`[binary] Download complete in ${downloadMs}ms (${binSize} bytes)`)

  if (remoteDigest && remoteDigest.startsWith('sha256:')) {
    const expectedHex = remoteDigest.slice('sha256:'.length)
    core.info(`[binary] Verifying sha256...`)
    const actualHex = sha256File(binPath)
    if (actualHex !== expectedHex) {
      fs.unlinkSync(binPath)
      throw new Error(
        `local-ai-cli-bin digest mismatch — expected sha256:${expectedHex}, got sha256:${actualHex}. ` +
        'The downloaded binary may be corrupted. Retry the workflow.'
      )
    }
    core.info(`[binary] Digest verified ✔ sha256:${actualHex}`)
  } else {
    core.info(`[binary] No sha256 digest to verify — skipping integrity check`)
  }

  fs.chmodSync(binPath, 0o755)
  fs.writeFileSync(digestPath, cacheKey, 'utf8')
  core.info(`[binary] Binary ready at ${binPath}`)
  return binPath
}
