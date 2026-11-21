import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { execSubprocess } from './adapters.js'

const GIT_TIMEOUT_MS = 30_000

export interface PrepareWorktreeInput {
  repoRoot: string
  issueNumber: number
  baseBranch?: string
  worktreeBaseDir?: string
}

export interface PreparedWorktree {
  worktreePath: string
  branchName: string
  baseBranch: string
  created: boolean
}

/** Error raised when git worktree or branch isolation fails. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeError'
  }
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return execSubprocess('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS })
}

async function runGitStrict(cwd: string, args: string[]): Promise<string> {
  const res = await runGit(cwd, args)
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim()
    throw new WorktreeError(
      `git ${args.join(' ')} failed (exit ${res.exitCode})${detail ? `: ${detail}` : ''}`,
    )
  }
  return res.stdout.trim()
}

export async function isGitRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false
  const res = await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
  return res.exitCode === 0 && res.stdout.trim() === 'true'
}

export async function resolveDefaultBranch(repoRoot: string): Promise<string> {
  const originHead = await runGit(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead.exitCode === 0) {
    const ref = originHead.stdout.trim()
    const slash = ref.indexOf('/')
    if (slash !== -1) {
      return ref.slice(slash + 1)
    }
  }
  const hasMain = await runGit(repoRoot, ['show-ref', '--verify', '--quiet', 'refs/heads/main'])
  if (hasMain.exitCode === 0) return 'main'
  return runGitStrict(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

/**
 * Creates or reuses an isolated `git worktree` and `ticket/<n>` branch for a Dinesh run.
 */
export async function prepareTicketWorktree(input: PrepareWorktreeInput): Promise<PreparedWorktree> {
  const repoRoot = path.resolve(input.repoRoot)
  const baseBranch = input.baseBranch ?? (await resolveDefaultBranch(repoRoot))
  const branchName = `ticket/${input.issueNumber}`
  const worktreeBase = input.worktreeBaseDir
    ? path.resolve(input.worktreeBaseDir)
    : path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`)
  const worktreePath = path.join(worktreeBase, `ticket-${input.issueNumber}`)

  if (existsSync(worktreePath) && (await isGitRepo(worktreePath))) {
    const currentBranch = await runGitStrict(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (currentBranch !== branchName) {
      throw new WorktreeError(
        `Existing worktree "${worktreePath}" is on branch "${currentBranch}", expected "${branchName}"`,
      )
    }
    return { worktreePath, branchName, baseBranch, created: false }
  }

  await mkdir(worktreeBase, { recursive: true })

  const branchExists =
    (await runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]))
      .exitCode === 0

  if (branchExists) {
    await runGitStrict(repoRoot, ['worktree', 'add', worktreePath, branchName])
  } else {
    await runGitStrict(repoRoot, ['worktree', 'add', worktreePath, '-b', branchName, baseBranch])
  }

  return { worktreePath, branchName, baseBranch, created: true }
}

/**
 * Returns true if `branchName` (or current HEAD in `worktreePath`) has commits ahead of `baseBranch`.
 */
export async function hasAheadCommits(worktreePath: string, baseBranch: string): Promise<boolean> {
  const out = await runGitStrict(worktreePath, ['rev-list', '--count', `${baseBranch}..HEAD`])
  return Number(out) > 0
}

/**
 * Pushes `branchName` to `origin` when an `origin` remote is configured.
 */
export async function pushBranchIfRemoteExists(worktreePath: string, branchName: string): Promise<boolean> {
  const remoteCheck = await runGit(worktreePath, ['remote', 'get-url', 'origin'])
  if (remoteCheck.exitCode !== 0) {
    return false
  }
  await runGitStrict(worktreePath, ['push', '-u', 'origin', branchName])
  return true
}

/**
 * Returns the unified diff between `baseBranch` and `HEAD` in the given worktree.
 */
export async function getBranchDiff(worktreePath: string, baseBranch: string): Promise<string> {
  return runGitStrict(worktreePath, ['diff', `${baseBranch}..HEAD`])
}
