import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AdapterResolver, AdapterUsage } from './adapters.js'
import type { AccessMode, AdapterType, PiedPiperConfig, RoleConfig } from './config.js'
import type { EventLog } from './event-log.js'
import type { GitHubIssue, GitHubPort, GitHubPullRequest } from './github.js'
import type { Notifier } from './notifications.js'
import {
  hasAheadCommits,
  isGitRepo,
  prepareTicketWorktree,
  pushBranchIfRemoteExists,
} from './worktree.js'

export const DEFAULT_RUN_TIMEOUT_MS = 300_000

export type ParsedTarget =
  | { kind: 'issue'; number: number; label: string }
  | { kind: 'pr'; number: number; label: string }
  | { kind: 'raw'; label: string }

export interface RunRoleInput {
  repoRoot: string
  config: PiedPiperConfig
  roleName: string
  target: string
  resolveAdapter: AdapterResolver
  cwd?: string
  timeoutMs?: number
  sessionId?: string
  extraContextPaths?: string[]
  extraInstructions?: string[]
  github?: GitHubPort
  worktreeBaseDir?: string
  baseBranch?: string
  publishReview?: boolean
  eventLog?: EventLog
  notifier?: Notifier
  hop?: number
}

export interface RunRoleResult {
  roleName: string
  target: string
  adapter: AdapterType
  model?: string
  access: AccessMode
  cwd: string
  prompt: string
  reply: string
  sessionId?: string
  usage?: AdapterUsage
  worktreePath?: string
  branchName?: string
  pullRequestNumber?: number
  contextFiles?: string[]
}

/** Error raised when role execution setup or target validation fails. */
export class RunnerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerError'
  }
}

function validateTargetPointer(rawTarget: string): string {
  const target = rawTarget.trim()
  if (target.length === 0) {
    throw new RunnerError('Target pointer must be a non-empty string')
  }
  if (/[\r\n\0]/.test(target)) {
    throw new RunnerError('Target pointer must not contain newlines or control characters')
  }
  return target
}

/**
 * Parses a validated target pointer into an issue (`#123`), PR (`PR #123`), or raw pointer.
 */
export function parseTargetPointer(rawTarget: string): ParsedTarget {
  const target = validateTargetPointer(rawTarget)
  const prMatch = target.match(/^PR\s*#?(\d+)$/i)
  if (prMatch?.[1]) {
    const number = Number(prMatch[1])
    return { kind: 'pr', number, label: `PR #${number}` }
  }
  const issueMatch = target.match(/^(?:issue\s*)?#?(\d+)$/i)
  if (issueMatch?.[1]) {
    const number = Number(issueMatch[1])
    return { kind: 'issue', number, label: `#${number}` }
  }
  return { kind: 'raw', label: target }
}

async function writeReadOnlyContextFile(dir: string, filename: string, content: string): Promise<string> {
  const filePath = path.join(dir, filename)
  await writeFile(filePath, content, 'utf8')
  await chmod(filePath, 0o444)
  return filePath
}

function formatIssueDocument(issue: GitHubIssue): string {
  return [
    `# Issue #${issue.number}: ${issue.title}`,
    `- State: ${issue.state}`,
    `- Labels: ${issue.labels.join(', ') || '(none)'}`,
    `- Parent: ${issue.parentNumber ? `#${issue.parentNumber}` : '(none)'}`,
    '',
    issue.body,
  ].join('\n')
}

function formatPullRequestDocument(pr: GitHubPullRequest): string {
  return [
    `# PR #${pr.number}: ${pr.title}`,
    `- State: ${pr.state}`,
    `- Branch: ${pr.headRefName} -> ${pr.baseRefName}`,
    `- Linked issues: ${pr.linkedIssueNumbers.map((n) => `#${n}`).join(', ') || '(none)'}`,
    '',
    pr.body,
  ].join('\n')
}

interface MaterializedContext {
  contextPaths: string[]
  parentSpecNumber?: number
  issue?: GitHubIssue
  pullRequest?: GitHubPullRequest
}

async function materializeExternalContext(params: {
  repoRoot: string
  roleName: string
  parsedTarget: ParsedTarget
  github: GitHubPort
}): Promise<MaterializedContext> {
  const { repoRoot, roleName, parsedTarget, github } = params
  const runDir = path.join(repoRoot, '.piedpiper', 'tmp', `${roleName}-${randomUUID()}`)
  await mkdir(runDir, { recursive: true })

  const contextPaths: string[] = []
  let parentSpecNumber: number | undefined
  let issue: GitHubIssue | undefined
  let pullRequest: GitHubPullRequest | undefined

  if (parsedTarget.kind === 'issue') {
    issue = await github.getIssue(parsedTarget.number)
    contextPaths.push(
      await writeReadOnlyContextFile(runDir, `issue-${issue.number}.md`, formatIssueDocument(issue)),
    )
    if (issue.parentNumber !== undefined) {
      parentSpecNumber = issue.parentNumber
      const spec = await github.getIssue(issue.parentNumber)
      contextPaths.push(
        await writeReadOnlyContextFile(runDir, `spec-${spec.number}.md`, formatIssueDocument(spec)),
      )
    }
  } else if (parsedTarget.kind === 'pr') {
    pullRequest = await github.getPullRequest(parsedTarget.number)
    const diff = await github.getPullRequestDiff(parsedTarget.number)

    contextPaths.push(
      await writeReadOnlyContextFile(runDir, `pr-${pullRequest.number}.diff`, diff),
    )
    contextPaths.push(
      await writeReadOnlyContextFile(
        runDir,
        `pr-${pullRequest.number}-meta.md`,
        formatPullRequestDocument(pullRequest),
      ),
    )

    // Blind review isolation: include only linked issue and spec files, never Dinesh reasoning/session logs.
    for (const issueNum of pullRequest.linkedIssueNumbers) {
      const linkedIssue = await github.getIssue(issueNum)
      contextPaths.push(
        await writeReadOnlyContextFile(
          runDir,
          `issue-${linkedIssue.number}.md`,
          formatIssueDocument(linkedIssue),
        ),
      )
      if (linkedIssue.parentNumber !== undefined && parentSpecNumber === undefined) {
        parentSpecNumber = linkedIssue.parentNumber
        const spec = await github.getIssue(linkedIssue.parentNumber)
        contextPaths.push(
          await writeReadOnlyContextFile(
            runDir,
            `spec-${spec.number}.md`,
            formatIssueDocument(spec),
          ),
        )
      }
    }
  }

  return { contextPaths, parentSpecNumber, issue, pullRequest }
}

function assemblePrompt(params: {
  roleName: string
  roleConfig: RoleConfig
  roleInstructions: string
  targetLabel: string
  parentSpecNumber?: number
  cwd: string
  extraContextPaths?: string[]
  extraInstructions?: string[]
}): string {
  const {
    roleName,
    roleConfig,
    roleInstructions,
    targetLabel,
    parentSpecNumber,
    cwd,
    extraContextPaths,
    extraInstructions,
  } = params

  const skillLines =
    roleConfig.skills.length > 0
      ? roleConfig.skills.map((skill) => `- ${skill}: ~/.claude/skills/${skill}/SKILL.md`)
      : ['- (none configured)']

  const accessRule =
    roleConfig.access === 'read'
      ? 'access: read (strictly read-only; do not edit files, create commits, or merge PRs)'
      : 'access: write (only modify files inside the assigned working directory)'

  const contextPointers = [
    `- Target object: ${targetLabel}`,
    ...(parentSpecNumber !== undefined ? [`- Parent spec: #${parentSpecNumber}`] : []),
    '- Domain glossary: GLOSSARY.md',
    '- Architecture decisions: docs/adr/',
    ...(extraContextPaths ?? []).map((p) => `- Context file: ${p}`),
  ]

  const extraSection =
    extraInstructions && extraInstructions.length > 0
      ? ['', '## Run-Specific Instructions', ...extraInstructions.map((line) => `- ${line}`)]
      : []

  return [
    roleInstructions.trim(),
    '',
    '## Runtime Context & Constraints',
    `- Role: ${roleName}`,
    `- ${accessRule}`,
    `- Working directory: ${cwd}`,
    ...extraSection,
    '',
    '## Configured Skills',
    ...skillLines,
    '',
    '## Context Pointers',
    ...contextPointers,
  ].join('\n')
}

async function ensurePullRequestForTicket(params: {
  github: GitHubPort
  worktreePath: string
  branchName: string
  baseBranch: string
  issueNumber: number
  issue?: GitHubIssue
}): Promise<number | undefined> {
  const { github, worktreePath, branchName, baseBranch, issueNumber, issue } = params
  if (!(await hasAheadCommits(worktreePath, baseBranch))) {
    return undefined
  }

  await pushBranchIfRemoteExists(worktreePath, branchName)

  const openPrs = await github.listOpenPullRequests()
  const existing = openPrs.find(
    (pr) => pr.headRefName === branchName || pr.linkedIssueNumbers.includes(issueNumber),
  )
  if (existing) {
    return existing.number
  }

  const prTitle = issue ? `${issue.title} (#${issueNumber})` : `Implement #${issueNumber}`
  const parentLine = issue?.parentNumber ? `\nPart of #${issue.parentNumber}` : ''
  const created = await github.createPullRequest({
    title: prTitle,
    body: `Closes #${issueNumber}${parentLine}`,
    head: branchName,
    base: baseBranch,
  })
  return created.number
}

/**
 * Executes a single role against a target pointer using the configured adapter.
 */
export async function runRole(input: RunRoleInput): Promise<RunRoleResult> {
  const roleConfig = input.config.roles[input.roleName]
  if (!roleConfig) {
    const known = Object.keys(input.config.roles).join(', ')
    throw new RunnerError(`Unknown role "${input.roleName}". Available roles: ${known}`)
  }

  const parsedTarget = parseTargetPointer(input.target)
  const timeoutMs = input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RunnerError(`Invalid timeoutMs "${timeoutMs}": expected a positive number`)
  }

  let cwd = path.resolve(input.cwd ?? input.repoRoot)
  let worktreePath: string | undefined
  let branchName: string | undefined
  let baseBranch: string | undefined

  if (
    roleConfig.access === 'write' &&
    parsedTarget.kind === 'issue' &&
    input.cwd === undefined &&
    (await isGitRepo(input.repoRoot))
  ) {
    const wt = await prepareTicketWorktree({
      repoRoot: input.repoRoot,
      issueNumber: parsedTarget.number,
      baseBranch: input.baseBranch,
      worktreeBaseDir: input.worktreeBaseDir,
    })
    cwd = wt.worktreePath
    worktreePath = wt.worktreePath
    branchName = wt.branchName
    baseBranch = wt.baseBranch
  }

  const materialized = input.github
    ? await materializeExternalContext({
        repoRoot: input.repoRoot,
        roleName: input.roleName,
        parsedTarget,
        github: input.github,
      })
    : undefined

  const extraContextPaths = [
    ...(input.extraContextPaths ?? []),
    ...(materialized?.contextPaths ?? []),
  ]

  const roleInstructions = await readFile(roleConfig.promptPath, 'utf8')
  const prompt = assemblePrompt({
    roleName: input.roleName,
    roleConfig,
    roleInstructions,
    targetLabel: parsedTarget.label,
    parentSpecNumber: materialized?.parentSpecNumber,
    cwd,
    extraContextPaths,
    extraInstructions: input.extraInstructions,
  })

  // Blind review isolation: read-only reviewers (e.g. Gilfoyle) never inherit a caller sessionId unless explicitly provided for that reviewer.
  const effectiveSessionId =
    roleConfig.access === 'read' && input.roleName === 'gilfoyle'
      ? undefined
      : input.sessionId

  await input.eventLog?.append({
    timestamp: new Date().toISOString(),
    type: 'run.started',
    role: input.roleName,
    target: parsedTarget.label,
    adapter: roleConfig.adapter,
    model: roleConfig.model,
    status: 'started',
    hop: input.hop,
  })

  try {
    const adapter = input.resolveAdapter(input.roleName, roleConfig)
    const response = await adapter.run({
      prompt,
      cwd,
      model: roleConfig.model,
      sessionId: effectiveSessionId,
      access: roleConfig.access,
      timeoutMs,
    })

    let pullRequestNumber = materialized?.pullRequest?.number
    if (
      input.github &&
      roleConfig.access === 'write' &&
      parsedTarget.kind === 'issue' &&
      worktreePath &&
      branchName &&
      baseBranch
    ) {
      pullRequestNumber = await ensurePullRequestForTicket({
        github: input.github,
        worktreePath,
        branchName,
        baseBranch,
        issueNumber: parsedTarget.number,
        issue: materialized?.issue,
      })
    }

    if (
      input.github &&
      roleConfig.access === 'read' &&
      parsedTarget.kind === 'pr' &&
      input.publishReview !== false &&
      response.reply.trim().length > 0
    ) {
      await input.github.submitPullRequestReview(parsedTarget.number, {
        body: response.reply,
        event: 'COMMENT',
      })
    }

    await input.eventLog?.append({
      timestamp: new Date().toISOString(),
      type: 'run.completed',
      role: input.roleName,
      target: parsedTarget.label,
      adapter: roleConfig.adapter,
      model: roleConfig.model,
      status: 'ok',
      usage: response.usage,
      sessionId: response.sessionId,
      pullRequestNumber,
      decision: pullRequestNumber ? `pr:#${pullRequestNumber}` : 'completed',
      hop: input.hop,
    })

    return {
      roleName: input.roleName,
      target: parsedTarget.label,
      adapter: roleConfig.adapter,
      model: roleConfig.model,
      access: roleConfig.access,
      cwd,
      prompt,
      reply: response.reply,
      sessionId: response.sessionId,
      usage: response.usage,
      worktreePath,
      branchName,
      pullRequestNumber,
      contextFiles: materialized?.contextPaths,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await input.eventLog
      ?.append({
        timestamp: new Date().toISOString(),
        type: 'run.failed',
        role: input.roleName,
        target: parsedTarget.label,
        adapter: roleConfig.adapter,
        model: roleConfig.model,
        status: 'failed',
        error: message,
        hop: input.hop,
      })
      .catch(() => {})

    await input.notifier
      ?.notify({
        title: `Pied Piper run failed (${input.roleName} -> ${parsedTarget.label})`,
        body: message,
        reason: 'run_failed',
        targetNumber: parsedTarget.kind === 'raw' ? undefined : parsedTarget.number,
      })
      .catch(() => {})

    throw error
  }
}
