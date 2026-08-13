export interface ReviewFile {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

export interface DiffResult {
  diffBlock: string
  truncated: boolean
  truncatedAt?: string
  includedFileCount: number
  skippedFiles: string[]
}

export function buildDiffBlock(
  files: ReviewFile[],
  maxChars: number
): DiffResult {
  let diffBlock = ''
  let truncated = false
  let truncatedAt: string | undefined
  let includedFileCount = 0
  const skippedFiles: string[] = []

  for (const f of files) {
    if (!f.patch) {
      skippedFiles.push(f.filename)
      continue
    }

    const chunk =
      `### ${f.filename} (${f.status})\n` +
      `\`\`\`diff\n${f.patch}\n\`\`\`\n\n`

    if ((diffBlock + chunk).length > maxChars) {
      truncated = true
      truncatedAt = f.filename
      break
    }

    diffBlock += chunk
    includedFileCount += 1
  }

  return {
    diffBlock,
    truncated,
    truncatedAt,
    includedFileCount,
    skippedFiles,
  }
}
