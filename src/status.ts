import { listFrontierIssues } from './dispatcher.js'
import type { GitHubIssue, GitHubPullRequest } from './github.js'

const NEEDS_HUMAN_LABELS = new Set(['ready-for-human', 'needs-triage', 'needs-info'])

function byNumber(a: GitHubIssue, b: GitHubIssue): number {
  return a.number - b.number
}

function formatIssueLine(issue: GitHubIssue, prNumbers: readonly number[] = []): string {
  const base = `#${issue.number} ${issue.title}`
  if (prNumbers.length === 0) return base
  return `${base} (PR ${prNumbers.map((number) => `#${number}`).join(', ')})`
}

function linkedOpenPrNumbers(issue: GitHubIssue, openPrs: readonly GitHubPullRequest[]): number[] {
  return openPrs
    .filter((pr) => pr.state === 'OPEN' && pr.linkedIssueNumbers.includes(issue.number))
    .map((pr) => pr.number)
    .sort((a, b) => a - b)
}

function renderGroup(title: string, lines: readonly string[]): string {
  if (lines.length === 0) return `${title}:\n(none)\n`
  return `${title}:\n${lines.join('\n')}\n`
}

/**
 * Renders the four-group status board from the current open GitHub issues and pull requests.
 * Frontier uses the same rules as the dispatcher.
 */
export function formatStatusBoard(
  openIssues: readonly GitHubIssue[],
  openPrs: readonly GitHubPullRequest[],
): string {
  const frontier = listFrontierIssues(openIssues, openPrs).slice().sort(byNumber)
  const inProgress = openIssues.filter((issue) => issue.labels.includes('in-progress')).slice().sort(byNumber)
  const inReview = openIssues.filter((issue) => issue.labels.includes('in-review')).slice().sort(byNumber)
  const needsHuman = openIssues
    .filter((issue) => issue.labels.some((label) => NEEDS_HUMAN_LABELS.has(label)))
    .slice()
    .sort(byNumber)

  return [
    renderGroup('Frontier', frontier.map((issue) => formatIssueLine(issue))),
    renderGroup('In Progress', inProgress.map((issue) => formatIssueLine(issue))),
    renderGroup(
      'In Review',
      inReview.map((issue) => formatIssueLine(issue, linkedOpenPrNumbers(issue, openPrs))),
    ),
    renderGroup('Needs Human', needsHuman.map((issue) => formatIssueLine(issue))),
  ].join('')
}
