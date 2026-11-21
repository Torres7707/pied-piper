export interface ReviewFinding {
  severity: 'blocking' | 'advisory'
  location: string
  rationale: string
  rawText: string
}

export interface ReviewValidationResult {
  valid: boolean
  reason?: string
  approved: boolean
  blockingFindings: ReviewFinding[]
  advisoryFindings: ReviewFinding[]
}

const FILE_LINE_PATTERN = /(?:`([^`\s]+:\d+)`|\b([A-Za-z0-9_./-]+\.[A-Za-z0-9_]+:\d+)\b)/
const BLOCKING_TAG_PATTERN = /(?:\[\s*阻塞级\s*\]|\[\s*blocking\s*\]|\*\*阻塞级\*\*|\*\*blocking\*\*|\bblocking\s*:|阻塞级\s*[:：])/i
const ADVISORY_TAG_PATTERN = /(?:\[\s*建议级\s*\]|\[\s*advisory\s*\]|\*\*建议级\*\*|\*\*advisory\*\*|\badvisory\s*:|建议级\s*[:：])/i

const VAGUE_APPROVAL_ONLY_PATTERN =
  /^(?:lgtm|looks\s+good(?:\s+to\s+me)?|ship\s+it|ok|pass|approved|看起来不错|代码整体清晰|没问题|通过)[.!。！\s]*$/i

function splitFindingBlocks(reply: string): string[] {
  const lines = reply.split(/\r?\n/)
  const blocks: string[] = []
  let current: string[] = []
  let inApprovalSection = false

  for (const line of lines) {
    if (/^\s*#{1,6}\s+.*(?:通过理由|approval|rationale\s+for\s+approval)/i.test(line)) {
      if (current.length > 0) {
        blocks.push(current.join('\n').trim())
        current = []
      }
      inApprovalSection = true
      continue
    }

    if (/^\s*#{1,6}\s+/.test(line)) {
      if (current.length > 0) {
        blocks.push(current.join('\n').trim())
        current = []
      }
      inApprovalSection = false
      continue
    }

    if (inApprovalSection) {
      continue
    }

    const isFindingStart =
      /^\s*(?:\d+\.|[-*])\s+(?:\*\*)?(?:\[\s*(?:阻塞级|建议级|blocking|advisory)\s*\]|(?:阻塞级|建议级|blocking|advisory)\s*[:：*])/i.test(
        line,
      )
    if (isFindingStart) {
      if (current.length > 0) {
        blocks.push(current.join('\n').trim())
      }
      current = [line]
    } else if (current.length > 0) {
      current.push(line)
    }
  }

  if (current.length > 0) {
    blocks.push(current.join('\n').trim())
  }

  return blocks
}

function hasRationaleEvidence(block: string): boolean {
  const inlineMatch = block.match(/(?:依据|说明|原因|basis|reason|evidence|rationale)\s*[:：]\s*([^\r\n]+)/i)
  if (inlineMatch?.[1] && inlineMatch[1].trim().length >= 6) {
    return true
  }
  const restLines = block.split(/\r?\n/).slice(1).join(' ').trim()
  return restLines.length >= 12
}

function hasJustifiedApproval(reply: string): boolean {
  const trimmed = reply.trim()
  if (trimmed.length < 24 || VAGUE_APPROVAL_ONLY_PATTERN.test(trimmed)) {
    return false
  }
  const hasPassConclusion =
    /(?:评审结论\s*[:：]\s*(?:通过|仅建议)|通过理由|approved|no\s+blocking\s+issues|无阻塞级)/i.test(
      trimmed,
    )
  const hasVerificationDetail =
    /(?:核对范围|验收标准核对|checked\s+files|verified|acceptance\s+criteria|测试|diff|边界)/i.test(
      trimmed,
    )
  return hasPassConclusion && hasVerificationDetail
}

/**
 * Validates and parses Gilfoyle's review output against the adversarial review contract.
 */
export function validateGilfoyleOutput(reply: string): ReviewValidationResult {
  const trimmed = reply.trim()
  if (trimmed.length === 0) {
    return {
      valid: false,
      reason: 'Review output is empty',
      approved: false,
      blockingFindings: [],
      advisoryFindings: [],
    }
  }

  const blocks = splitFindingBlocks(trimmed)
  const blockingFindings: ReviewFinding[] = []
  const advisoryFindings: ReviewFinding[] = []

  for (const block of blocks) {
    const isBlocking = BLOCKING_TAG_PATTERN.test(block)
    const isAdvisory = ADVISORY_TAG_PATTERN.test(block)
    if (!isBlocking && !isAdvisory) {
      return {
        valid: false,
        reason: 'Finding is missing severity tag ([阻塞级]/Blocking or [建议级]/Advisory)',
        approved: false,
        blockingFindings: [],
        advisoryFindings: [],
      }
    }

    const locMatch = block.match(FILE_LINE_PATTERN)
    const location = locMatch?.[1] ?? locMatch?.[2]
    if (!location) {
      return {
        valid: false,
        reason: 'Finding is missing a file:line location (e.g. src/file.ts:42)',
        approved: false,
        blockingFindings: [],
        advisoryFindings: [],
      }
    }

    if (!hasRationaleEvidence(block)) {
      return {
        valid: false,
        reason: `Finding at ${location} is missing concrete rationale/evidence`,
        approved: false,
        blockingFindings: [],
        advisoryFindings: [],
      }
    }

    const finding: ReviewFinding = {
      severity: isBlocking ? 'blocking' : 'advisory',
      location,
      rationale: block,
      rawText: block,
    }
    if (finding.severity === 'blocking') {
      blockingFindings.push(finding)
    } else {
      advisoryFindings.push(finding)
    }
  }

  if (blocks.length > 0) {
    return {
      valid: true,
      approved: blockingFindings.length === 0,
      blockingFindings,
      advisoryFindings,
    }
  }

  if (hasJustifiedApproval(trimmed)) {
    return {
      valid: true,
      approved: true,
      blockingFindings: [],
      advisoryFindings: [],
    }
  }

  return {
    valid: false,
    reason:
      'Review output must include at least one concrete finding (file:line, rationale, severity) or a justified approval with checked scope and criteria',
    approved: false,
    blockingFindings: [],
    advisoryFindings: [],
  }
}

/**
 * Formats ONLY blocking findings into a focused context document for Dinesh fixes and Round 2 Gilfoyle re-review.
 */
export function formatBlockingFindingsContext(
  prNumber: number,
  findings: ReviewFinding[],
): string {
  return [
    `# PR #${prNumber} Round 1 Blocking Findings`,
    '',
    'Only the blocking findings below require resolution and Round 2 verification:',
    '',
    ...findings.map((f, idx) => `${idx + 1}. ${f.rawText}`),
  ].join('\n')
}
