import * as fs from 'fs'
import * as https from 'https'
import * as crypto from 'crypto'

export function httpsGetJson(url: string, token?: string, redirectsLeft = 5): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': 'runbot-hq/local-ai-code-review-action',
      'Accept': 'application/vnd.github+json',
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects fetching ${url}`))
        resolve(httpsGetJson(res.headers.location, token, redirectsLeft - 1))
        return
      }
      if (res.statusCode !== 200) return reject(new Error(`GitHub API returned HTTP ${res.statusCode} for ${url}`))
      let body = ''
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(new Error(`Failed to parse JSON from ${url}: ${e}`)) }
      })
    })
    req.on('error', reject)
  })
}

// Auth token is intentionally NOT forwarded here. browser_download_url for
// public GitHub releases resolves via a 302 redirect to an unauthenticated
// S3/CDN URL — sending a Bearer token to that URL is both unnecessary and
// would cause a 400. If this action is ever used against a private release
// repo, this function will need to use the GitHub API asset-download endpoint
// with an Authorization header instead.
export function httpsDownload(url: string, destPath: string, redirectsLeft = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'runbot-hq/local-ai-code-review-action' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects downloading ${url}`))
        resolve(httpsDownload(res.headers.location, destPath, redirectsLeft - 1))
        return
      }
      if (res.statusCode !== 200) return reject(new Error(`Download returned HTTP ${res.statusCode} for ${url}`))
      const file = fs.createWriteStream(destPath)
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e) })
    })
    req.on('error', reject)
  })
}

export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}
