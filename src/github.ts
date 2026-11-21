import { execSubprocess } from './adapters.js'

export interface GitHubIssueRef {
  number: number
  state: 'OPEN' | 'CLOSED'
  title?: string
}

export interface GitHubIssue {
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED'
  labels: string[]
  blockedBy: GitHubIssueRef[]
  parentNumber?: number
}

export interface GitHubPullRequest {
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  headRefName: string
  baseRefName: string
  linkedIssueNumbers: number[]
  url?: string
}

export interface GitHubReview {
  author?: string
  body: string
  state: string
  submittedAt?: string
}

export interface CreateIssueInput {
  title: string
  body: string
  labels?: string[]
  parentNumber?: number
  blockedByNumbers?: number[]
}

export interface GitHubLabelSpec {
  name: string
  color: string
  description: string
}

export const STANDARD_GITHUB_LABELS: readonly GitHubLabelSpec[] = [
  {
    name: 'ready-for-agent',
    color: '0e8a16',
    description: 'Fully specified, ready for an AFK agent',
  },
  {
    name: 'in-progress',
    color: 'fbca04',
    description: 'Claimed by a Dinesh instance',
  },
  {
    name: 'in-review',
    color: '5319e7',
    description: 'PR opened and handed over to Gilfoyle for review',
  },
  {
    name: 'ready-for-human',
    color: 'd93f0b',
    description: 'Requires developer decision or implementation',
  },
  {
    name: 'needs-triage',
    color: 'ededed',
    description: 'Maintainer needs to evaluate this issue',
  },
  {
    name: 'needs-info',
    color: 'd876e3',
    description: 'Waiting on reporter for more information',
  },
  {
    name: 'wontfix',
    color: 'ffffff',
    description: 'Will not be actioned',
  },
]

export interface CreatePullRequestInput {
  title: string
  body: string
  head: string
  base: string
}

export interface SubmitReviewInput {
  body: string
  event?: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'
}

/** Unified outer-seam contract for GitHub state reads and writes (never exposes PR merge). */
export interface GitHubPort {
  listOpenIssues(): Promise<GitHubIssue[]>
  getIssue(issueNumber: number): Promise<GitHubIssue>
  createIssue(input: CreateIssueInput): Promise<GitHubIssue>
  ensureLabels(labels: readonly GitHubLabelSpec[]): Promise<void>
  addLabels(issueNumber: number, labels: string[]): Promise<void>
  removeLabels(issueNumber: number, labels: string[]): Promise<void>
  listOpenPullRequests(): Promise<GitHubPullRequest[]>
  getPullRequest(prNumber: number): Promise<GitHubPullRequest>
  getPullRequestDiff(prNumber: number): Promise<string>
  listPullRequestReviews(prNumber: number): Promise<GitHubReview[]>
  createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest>
  submitPullRequestReview(prNumber: number, input: SubmitReviewInput): Promise<void>
  addIssueComment(targetNumber: number, body: string): Promise<void>
}

/** Diagnostic error raised when a GitHub CLI or state operation fails. */
export class GitHubError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubError'
  }
}

export interface GhGitHubPortOptions {
  cwd: string
  owner?: string
  repo?: string
  command?: string
  baseArgs?: string[]
  timeoutMs?: number
}

const DEFAULT_GH_TIMEOUT_MS = 30_000

function parseRepoSlugFromRemoteUrl(remoteUrl: string): { owner: string; repo: string } | null {
  const trimmed = remoteUrl.trim()
  // Match git@github.com:owner/repo.git or https://github.com/owner/repo(.git)
  const sshMatch = trimmed.match(/^[^@]+@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] }
  }
  const httpsMatch = trimmed.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] }
  }
  return null
}

function normalizeIssueState(state: unknown): 'OPEN' | 'CLOSED' {
  return String(state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
}

function normalizePrState(state: unknown): 'OPEN' | 'CLOSED' | 'MERGED' {
  const upper = String(state).toUpperCase()
  if (upper === 'MERGED') return 'MERGED'
  if (upper === 'CLOSED') return 'CLOSED'
  return 'OPEN'
}

function extractClosingIssueNumbers(body: string, refs?: Array<{ number?: number }>): number[] {
  const numbers = new Set<number>()
  for (const ref of refs ?? []) {
    if (typeof ref.number === 'number' && Number.isInteger(ref.number)) {
      numbers.add(ref.number)
    }
  }
  const matches = body.matchAll(/(?:closes|fixes|resolves|refs?)\s+#(\d+)/gi)
  for (const match of matches) {
    const parsed = Number(match[1])
    if (Number.isInteger(parsed)) {
      numbers.add(parsed)
    }
  }
  return [...numbers]
}

interface RawGraphqlIssueNode {
  number: number
  title: string
  body?: string | null
  state: string
  labels?: { nodes?: Array<{ name: string }> }
  blockedBy?: { nodes?: Array<{ number: number; state: string; title?: string }> }
  parent?: { number: number } | null
}

function mapGraphqlIssue(node: RawGraphqlIssueNode): GitHubIssue {
  return {
    number: node.number,
    title: node.title,
    body: node.body ?? '',
    state: normalizeIssueState(node.state),
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    blockedBy: (node.blockedBy?.nodes ?? []).map((b) => ({
      number: b.number,
      state: normalizeIssueState(b.state),
      title: b.title,
    })),
    parentNumber: node.parent?.number,
  }
}

interface RawGhPr {
  number: number
  title: string
  body?: string | null
  state: string
  headRefName: string
  baseRefName: string
  url?: string
  closingIssuesReferences?: Array<{ number?: number }>
}

function mapGhPr(raw: RawGhPr): GitHubPullRequest {
  const body = raw.body ?? ''
  return {
    number: raw.number,
    title: raw.title,
    body,
    state: normalizePrState(raw.state),
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    url: raw.url,
    linkedIssueNumbers: extractClosingIssueNumbers(body, raw.closingIssuesReferences),
  }
}

/**
 * Production `GitHubPort` backed by the local `gh` CLI via `shell: false` subprocesses.
 */
export function createGhGitHubPort(options: GhGitHubPortOptions): GitHubPort {
  const command = options.command ?? 'gh'
  const baseArgs = options.baseArgs ?? []
  const timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS
  let cachedSlug: { owner: string; repo: string } | undefined =
    options.owner && options.repo ? { owner: options.owner, repo: options.repo } : undefined

  async function runGh(args: string[]): Promise<string> {
    const result = await execSubprocess(command, [...baseArgs, ...args], {
      cwd: options.cwd,
      timeoutMs,
    })
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new GitHubError(
        `gh ${args.slice(0, 2).join(' ')} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`,
      )
    }
    return result.stdout
  }

  async function resolveRepoSlug(): Promise<{ owner: string; repo: string }> {
    if (cachedSlug) return cachedSlug
    const gitRes = await execSubprocess('git', ['remote', 'get-url', 'origin'], {
      cwd: options.cwd,
      timeoutMs,
    })
    if (gitRes.exitCode === 0) {
      const slug = parseRepoSlugFromRemoteUrl(gitRes.stdout)
      if (slug) {
        cachedSlug = slug
        return slug
      }
    }
    const repoJson = await runGh(['repo', 'view', '--json', 'owner,name'])
    const parsed = JSON.parse(repoJson) as { owner?: { login?: string }; name?: string }
    if (!parsed.owner?.login || !parsed.name) {
      throw new GitHubError('Could not resolve GitHub owner/repo from git remote or gh repo view')
    }
    cachedSlug = { owner: parsed.owner.login, repo: parsed.name }
    return cachedSlug
  }

  return {
    async listOpenIssues(): Promise<GitHubIssue[]> {
      const { owner, repo } = await resolveRepoSlug()
      const query = `
        query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            issues(first: 100, states: OPEN, orderBy: { field: CREATED_AT, direction: ASC }) {
              nodes {
                number
                title
                body
                state
                labels(first: 30) { nodes { name } }
                blockedBy(first: 20) { nodes { number state title } }
                parent { number }
              }
            }
          }
        }
      `
      const out = await runGh([
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `repo=${repo}`,
      ])
      const parsed = JSON.parse(out) as {
        data?: { repository?: { issues?: { nodes?: RawGraphqlIssueNode[] } } }
      }
      const nodes = parsed.data?.repository?.issues?.nodes ?? []
      return nodes.map(mapGraphqlIssue)
    },

    async getIssue(issueNumber: number): Promise<GitHubIssue> {
      const { owner, repo } = await resolveRepoSlug()
      const query = `
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) {
              number
              title
              body
              state
              labels(first: 30) { nodes { name } }
              blockedBy(first: 20) { nodes { number state title } }
              parent { number }
            }
          }
        }
      `
      const out = await runGh([
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `repo=${repo}`,
        '-F',
        `number=${issueNumber}`,
      ])
      const parsed = JSON.parse(out) as {
        data?: { repository?: { issue?: RawGraphqlIssueNode | null } }
      }
      const node = parsed.data?.repository?.issue
      if (!node) {
        throw new GitHubError(`Issue #${issueNumber} not found`)
      }
      return mapGraphqlIssue(node)
    },

    async createIssue(input: CreateIssueInput): Promise<GitHubIssue> {
      const args = ['issue', 'create', '--title', input.title, '--body', input.body]
      for (const label of input.labels ?? []) {
        args.push('--label', label)
      }
      if (input.parentNumber !== undefined) {
        args.push('--parent', String(input.parentNumber))
      }
      if (input.blockedByNumbers && input.blockedByNumbers.length > 0) {
        args.push('--blocked-by', input.blockedByNumbers.join(','))
      }
      const out = await runGh(args)
      const issueUrl = out.trim().split(/\r?\n/).at(-1) ?? ''
      const match = issueUrl.match(/\/issues\/(\d+)/)
      if (match?.[1]) {
        return this.getIssue(Number(match[1]))
      }
      throw new GitHubError(
        `Created issue "${input.title}" but could not resolve issue number from output: ${out.trim()}`,
      )
    },

    async ensureLabels(labels: readonly GitHubLabelSpec[]): Promise<void> {
      for (const label of labels) {
        await runGh([
          'label',
          'create',
          label.name,
          '--color',
          label.color,
          '--description',
          label.description,
          '--force',
        ])
      }
    },

    async addLabels(issueNumber: number, labels: string[]): Promise<void> {
      if (labels.length === 0) return
      const args = ['issue', 'edit', String(issueNumber)]
      for (const label of labels) {
        args.push('--add-label', label)
      }
      await runGh(args)
    },

    async removeLabels(issueNumber: number, labels: string[]): Promise<void> {
      if (labels.length === 0) return
      const args = ['issue', 'edit', String(issueNumber)]
      for (const label of labels) {
        args.push('--remove-label', label)
      }
      await runGh(args)
    },

    async listOpenPullRequests(): Promise<GitHubPullRequest[]> {
      const out = await runGh([
        'pr',
        'list',
        '--state',
        'open',
        '--json',
        'number,title,body,state,headRefName,baseRefName,url,closingIssuesReferences',
      ])
      const list = JSON.parse(out) as RawGhPr[]
      return list.map(mapGhPr)
    },

    async getPullRequest(prNumber: number): Promise<GitHubPullRequest> {
      const out = await runGh([
        'pr',
        'view',
        String(prNumber),
        '--json',
        'number,title,body,state,headRefName,baseRefName,url,closingIssuesReferences',
      ])
      return mapGhPr(JSON.parse(out) as RawGhPr)
    },

    async getPullRequestDiff(prNumber: number): Promise<string> {
      return runGh(['pr', 'diff', String(prNumber)])
    },

    async listPullRequestReviews(prNumber: number): Promise<GitHubReview[]> {
      const out = await runGh(['pr', 'view', String(prNumber), '--json', 'reviews'])
      const parsed = JSON.parse(out) as {
        reviews?: Array<{
          author?: { login?: string }
          body?: string
          state?: string
          submittedAt?: string
        }>
      }
      return (parsed.reviews ?? []).map((r) => ({
        author: r.author?.login,
        body: r.body ?? '',
        state: r.state ?? 'COMMENTED',
        submittedAt: r.submittedAt,
      }))
    },

    async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
      const out = await runGh([
        'pr',
        'create',
        '--title',
        input.title,
        '--body',
        input.body,
        '--head',
        input.head,
        '--base',
        input.base,
      ])
      const prUrl = out.trim().split(/\r?\n/).at(-1) ?? ''
      const match = prUrl.match(/\/pull\/(\d+)/)
      if (match?.[1]) {
        return this.getPullRequest(Number(match[1]))
      }
      const prs = await this.listOpenPullRequests()
      const found = prs.find((p) => p.headRefName === input.head)
      if (found) return found
      throw new GitHubError(`Created PR for branch "${input.head}" but could not resolve PR number`)
    },

    async submitPullRequestReview(prNumber: number, input: SubmitReviewInput): Promise<void> {
      const eventFlag =
        input.event === 'REQUEST_CHANGES'
          ? '--request-changes'
          : input.event === 'APPROVE'
            ? '--approve'
            : '--comment'
      await runGh(['pr', 'review', String(prNumber), eventFlag, '--body', input.body])
    },

    async addIssueComment(targetNumber: number, body: string): Promise<void> {
      await runGh(['issue', 'comment', String(targetNumber), '--body', body])
    },
  }
}

export interface InMemoryPullRequestSeed extends GitHubPullRequest {
  diff?: string
  reviews?: GitHubReview[]
}

export interface InMemoryGitHubSeed {
  issues?: GitHubIssue[]
  pullRequests?: InMemoryPullRequestSeed[]
}

export interface InMemoryGitHubPort extends GitHubPort {
  setPullRequestDiff(prNumber: number, diff: string): void
  closeIssue(issueNumber: number): void
  getIssueComments(targetNumber: number): string[]
  getEnsuredLabels(): GitHubLabelSpec[]
}

/**
 * In-memory fake `GitHubPort` for outer-seam behavior tests without network calls.
 */
export function createInMemoryGitHubPort(seed: InMemoryGitHubSeed = {}): InMemoryGitHubPort {
  const issues = new Map<number, GitHubIssue>()
  const prs = new Map<number, GitHubPullRequest>()
  const diffs = new Map<number, string>()
  const reviews = new Map<number, GitHubReview[]>()
  const comments = new Map<number, string[]>()
  const ensuredLabels = new Map<string, GitHubLabelSpec>()

  let nextIssueNumber = 1
  let nextPrNumber = 1
  for (const issue of seed.issues ?? []) {
    issues.set(issue.number, {
      ...issue,
      labels: [...issue.labels],
      blockedBy: issue.blockedBy.map((b) => ({ ...b })),
    })
    nextIssueNumber = Math.max(nextIssueNumber, issue.number + 1)
  }
  for (const pr of seed.pullRequests ?? []) {
    const { diff, reviews: prReviews, ...prData } = pr
    prs.set(pr.number, {
      ...prData,
      linkedIssueNumbers: [...prData.linkedIssueNumbers],
    })
    if (diff !== undefined) diffs.set(pr.number, diff)
    if (prReviews !== undefined) reviews.set(pr.number, prReviews.map((r) => ({ ...r })))
    nextPrNumber = Math.max(nextPrNumber, pr.number + 1)
  }

  function refreshBlockedBy(issue: GitHubIssue): GitHubIssue {
    return {
      ...issue,
      labels: [...issue.labels],
      blockedBy: issue.blockedBy.map((ref) => {
        const target = issues.get(ref.number)
        return target
          ? { number: target.number, state: target.state, title: target.title }
          : { ...ref }
      }),
    }
  }

  return {
    async listOpenIssues(): Promise<GitHubIssue[]> {
      return [...issues.values()]
        .filter((i) => i.state === 'OPEN')
        .sort((a, b) => a.number - b.number)
        .map(refreshBlockedBy)
    },

    async getIssue(issueNumber: number): Promise<GitHubIssue> {
      const issue = issues.get(issueNumber)
      if (!issue) throw new GitHubError(`Issue #${issueNumber} not found`)
      return refreshBlockedBy(issue)
    },

    async createIssue(input: CreateIssueInput): Promise<GitHubIssue> {
      if (input.parentNumber !== undefined && !issues.has(input.parentNumber)) {
        throw new GitHubError(`Parent issue #${input.parentNumber} not found`)
      }
      const blockedBy: GitHubIssueRef[] = []
      for (const depNumber of input.blockedByNumbers ?? []) {
        const dep = issues.get(depNumber)
        if (!dep) {
          throw new GitHubError(`Blocking issue #${depNumber} not found`)
        }
        blockedBy.push({
          number: dep.number,
          state: dep.state,
          title: dep.title,
        })
      }
      const number = nextIssueNumber++
      const created: GitHubIssue = {
        number,
        title: input.title,
        body: input.body,
        state: 'OPEN',
        labels: [...new Set(input.labels ?? [])],
        blockedBy,
        ...(input.parentNumber !== undefined ? { parentNumber: input.parentNumber } : {}),
      }
      issues.set(number, created)
      return refreshBlockedBy(created)
    },

    async ensureLabels(labels: readonly GitHubLabelSpec[]): Promise<void> {
      for (const label of labels) {
        ensuredLabels.set(label.name, { ...label })
      }
    },

    async addLabels(issueNumber: number, labels: string[]): Promise<void> {
      const issue = issues.get(issueNumber)
      if (!issue) throw new GitHubError(`Issue #${issueNumber} not found`)
      for (const label of labels) {
        if (!issue.labels.includes(label)) {
          issue.labels.push(label)
        }
      }
    },

    async removeLabels(issueNumber: number, labels: string[]): Promise<void> {
      const issue = issues.get(issueNumber)
      if (!issue) throw new GitHubError(`Issue #${issueNumber} not found`)
      const toRemove = new Set(labels)
      issue.labels = issue.labels.filter((l) => !toRemove.has(l))
    },

    async listOpenPullRequests(): Promise<GitHubPullRequest[]> {
      return [...prs.values()]
        .filter((p) => p.state === 'OPEN')
        .sort((a, b) => a.number - b.number)
        .map((p) => ({ ...p, linkedIssueNumbers: [...p.linkedIssueNumbers] }))
    },

    async getPullRequest(prNumber: number): Promise<GitHubPullRequest> {
      const pr = prs.get(prNumber)
      if (!pr) throw new GitHubError(`PR #${prNumber} not found`)
      return { ...pr, linkedIssueNumbers: [...pr.linkedIssueNumbers] }
    },

    async getPullRequestDiff(prNumber: number): Promise<string> {
      if (!prs.has(prNumber)) throw new GitHubError(`PR #${prNumber} not found`)
      return diffs.get(prNumber) ?? ''
    },

    async listPullRequestReviews(prNumber: number): Promise<GitHubReview[]> {
      if (!prs.has(prNumber)) throw new GitHubError(`PR #${prNumber} not found`)
      return (reviews.get(prNumber) ?? []).map((r) => ({ ...r }))
    },

    async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
      const number = nextPrNumber++
      const pr: GitHubPullRequest = {
        number,
        title: input.title,
        body: input.body,
        state: 'OPEN',
        headRefName: input.head,
        baseRefName: input.base,
        linkedIssueNumbers: extractClosingIssueNumbers(input.body),
        url: `https://github.com/local/repo/pull/${number}`,
      }
      prs.set(number, pr)
      return { ...pr, linkedIssueNumbers: [...pr.linkedIssueNumbers] }
    },

    async submitPullRequestReview(prNumber: number, input: SubmitReviewInput): Promise<void> {
      if (!prs.has(prNumber)) throw new GitHubError(`PR #${prNumber} not found`)
      const list = reviews.get(prNumber) ?? []
      list.push({
        author: 'gilfoyle',
        body: input.body,
        state: input.event ?? 'COMMENT',
        submittedAt: new Date().toISOString(),
      })
      reviews.set(prNumber, list)
    },

    async addIssueComment(targetNumber: number, body: string): Promise<void> {
      if (!issues.has(targetNumber) && !prs.has(targetNumber)) {
        throw new GitHubError(`Issue or PR #${targetNumber} not found`)
      }
      const list = comments.get(targetNumber) ?? []
      list.push(body)
      comments.set(targetNumber, list)
    },

    setPullRequestDiff(prNumber: number, diff: string): void {
      diffs.set(prNumber, diff)
    },

    closeIssue(issueNumber: number): void {
      const issue = issues.get(issueNumber)
      if (!issue) throw new GitHubError(`Issue #${issueNumber} not found`)
      issue.state = 'CLOSED'
    },

    getIssueComments(targetNumber: number): string[] {
      return [...(comments.get(targetNumber) ?? [])]
    },

    getEnsuredLabels(): GitHubLabelSpec[] {
      return [...ensuredLabels.values()].map((l) => ({ ...l }))
    },
  }
}
