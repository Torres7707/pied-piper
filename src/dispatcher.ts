import path from 'node:path'
import type { AdapterResolver } from './adapters.js'
import type { PiedPiperConfig } from './config.js'
import type { EventLog } from './event-log.js'
import type { GitHubIssue, GitHubPort, GitHubPullRequest } from './github.js'
import type { Notifier } from './notifications.js'
import { runRole } from './runner.js'

export interface DispatchOnceInput {
  repoRoot: string
  config: PiedPiperConfig
  github: GitHubPort
  resolveAdapter: AdapterResolver
  worktreeBaseDir?: string
  baseBranch?: string
  timeoutMs?: number
  eventLog?: EventLog
  notifier?: Notifier
  hop?: number
}

export interface DispatchOnceResult {
  halted: boolean
  frontierIssues: number[]
  dispatchedDinesh: number[]
  dispatchedGilfoyle: number[]
  transitionedToReview: number[]
  errors: string[]
}

export interface DispatchPollInput extends DispatchOnceInput {
  intervalMs?: number
  maxCycles?: number
  signal?: AbortSignal
  onCycle?: (result: DispatchOnceResult, cycle: number) => void
}

function isFrontierIssue(
  issue: GitHubIssue,
  openPrs: GitHubPullRequest[],
  parentIdsWithOpenChildren: Set<number>,
): boolean {
  if (!issue.labels.includes('ready-for-agent')) return false
  if (issue.labels.includes('in-progress')) return false
  if (issue.labels.includes('in-review')) return false
  if (issue.labels.includes('ready-for-human')) return false
  if (parentIdsWithOpenChildren.has(issue.number)) return false
  if (issue.blockedBy.some((dep) => dep.state !== 'CLOSED')) return false
  if (openPrs.some((pr) => pr.linkedIssueNumbers.includes(issue.number))) return false
  return true
}

function getParentIdsWithOpenChildren(openIssues: GitHubIssue[]): Set<number> {
  const parents = new Set<number>()
  for (const issue of openIssues) {
    if (issue.parentNumber !== undefined) {
      parents.add(issue.parentNumber)
    }
  }
  return parents
}

async function transitionIssueToReview(
  github: GitHubPort,
  issue: GitHubIssue,
  eventLog?: EventLog,
  hop?: number,
): Promise<boolean> {
  if (issue.labels.includes('ready-for-human')) {
    return false
  }
  const hadInProgress = issue.labels.includes('in-progress')
  const needsInReview = !issue.labels.includes('in-review')
  if (!hadInProgress && !needsInReview) {
    return false
  }

  if (hadInProgress) {
    await github.removeLabels(issue.number, ['in-progress'])
  }
  if (needsInReview) {
    await github.addLabels(issue.number, ['in-review'])
  }
  await eventLog?.append({
    timestamp: new Date().toISOString(),
    type: 'label.transitioned',
    target: `#${issue.number}`,
    fromLabel: hadInProgress ? 'in-progress' : undefined,
    toLabel: 'in-review',
    decision: 'pr_opened',
    hop,
  })
  return true
}

async function haltDispatcher(params: {
  hop: number
  maxHops: number
  targetNumber?: number
  eventLog?: EventLog
  notifier?: Notifier
}): Promise<void> {
  const { hop, maxHops, targetNumber, eventLog, notifier } = params
  const target = targetNumber !== undefined ? `#${targetNumber}` : undefined
  await eventLog?.append({
    timestamp: new Date().toISOString(),
    type: 'dispatcher.halted',
    target,
    status: 'halted',
    decision: `hop_limit_reached (${hop}/${maxHops})`,
    hop,
  })
  await notifier?.notify({
    title: 'Pied Piper dispatcher halted',
    body: `Dispatcher reached hop limit (${hop}/${maxHops}) and stopped automatic dispatching.`,
    reason: 'hop_limit',
    targetNumber,
  })
}

async function inferChainHopFromLog(eventLog: EventLog | undefined): Promise<number> {
  if (!eventLog) return 0
  const events = await eventLog.readEvents()
  let lastHaltIndex = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'dispatcher.halted') {
      lastHaltIndex = i
      break
    }
  }
  const recent = events.slice(lastHaltIndex + 1)
  let maxHop = 0
  for (const evt of recent) {
    if (typeof evt.hop === 'number' && evt.hop > maxHop) {
      maxHop = evt.hop
    }
  }
  return maxHop
}

/**
 * Executes one stateless scheduling cycle using GitHub as the authoritative state source.
 */
export async function dispatchOnce(input: DispatchOnceInput): Promise<DispatchOnceResult> {
  const { repoRoot, config, github, resolveAdapter, eventLog, notifier } = input
  const maxHops = config.runtime.dispatcher.maxHops
  const dineshParallel = config.roles.dinesh?.parallel ?? 1

  const openIssues = await github.listOpenIssues()
  const openPrs = await github.listOpenPullRequests()
  const issueByNumber = new Map(openIssues.map((issue) => [issue.number, issue]))
  const parentIdsWithOpenChildren = getParentIdsWithOpenChildren(openIssues)

  const frontier = openIssues.filter((issue) =>
    isFrontierIssue(issue, openPrs, parentIdsWithOpenChildren),
  )

  let currentHop = input.hop ?? (await inferChainHopFromLog(eventLog))
  if (currentHop >= maxHops) {
    const notifyTarget =
      frontier[0]?.number ??
      openIssues.find((i) => i.labels.includes('in-progress') || i.labels.includes('in-review'))
        ?.number
    await haltDispatcher({
      hop: currentHop,
      maxHops,
      targetNumber: notifyTarget,
      eventLog,
      notifier,
    })
    return {
      halted: true,
      frontierIssues: frontier.map((i) => i.number),
      dispatchedDinesh: [],
      dispatchedGilfoyle: [],
      transitionedToReview: [],
      errors: [],
    }
  }

  const dispatchedDinesh: number[] = []
  const dispatchedGilfoyle: number[] = []
  const transitionedToReview: number[] = []
  const errors: string[] = []
  const reviewedPrsThisCycle = new Set<number>()

  // Step 1: Reconcile open PRs (transition linked issues to in-review and trigger Gilfoyle if unreviewed).
  for (const pr of openPrs) {
    let anyHumanEscalated = false
    for (const issueNum of pr.linkedIssueNumbers) {
      const linked = issueByNumber.get(issueNum)
      if (!linked) continue
      if (linked.labels.includes('ready-for-human')) {
        anyHumanEscalated = true
        continue
      }
      const transitioned = await transitionIssueToReview(github, linked, eventLog, currentHop)
      if (transitioned) {
        transitionedToReview.push(issueNum)
        linked.labels = linked.labels.filter((l) => l !== 'in-progress')
        if (!linked.labels.includes('in-review')) linked.labels.push('in-review')
      }
    }

    if (anyHumanEscalated || !config.roles.gilfoyle) continue

    const existingReviews = await github.listPullRequestReviews(pr.number)
    if (existingReviews.length === 0) {
      if (currentHop >= maxHops) {
        await haltDispatcher({
          hop: currentHop,
          maxHops,
          targetNumber: pr.linkedIssueNumbers[0] ?? pr.number,
          eventLog,
          notifier,
        })
        return {
          halted: true,
          frontierIssues: frontier.map((i) => i.number),
          dispatchedDinesh,
          dispatchedGilfoyle,
          transitionedToReview,
          errors,
        }
      }
      currentHop += 1
      try {
        await runRole({
          repoRoot,
          config,
          roleName: 'gilfoyle',
          target: `PR #${pr.number}`,
          resolveAdapter,
          timeoutMs: input.timeoutMs,
          github,
          eventLog,
          notifier,
          hop: currentHop,
        })
        dispatchedGilfoyle.push(pr.number)
        reviewedPrsThisCycle.add(pr.number)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
  }

  // Step 2: Claim frontier issues up to remaining Dinesh parallel capacity.
  if (config.roles.dinesh && frontier.length > 0) {
    const activeInProgressCount = openIssues.filter(
      (issue) =>
        issue.labels.includes('in-progress') &&
        !openPrs.some((pr) => pr.linkedIssueNumbers.includes(issue.number)),
    ).length

    const remainingSlots = Math.max(0, dineshParallel - activeInProgressCount)
    const toClaim: GitHubIssue[] = []
    for (const candidate of frontier) {
      if (toClaim.length >= remainingSlots) break
      if (currentHop + toClaim.length >= maxHops) break
      await github.addLabels(candidate.number, ['in-progress'])
      candidate.labels.push('in-progress')
      await eventLog?.append({
        timestamp: new Date().toISOString(),
        type: 'label.transitioned',
        role: 'dinesh',
        target: `#${candidate.number}`,
        toLabel: 'in-progress',
        decision: 'claimed_frontier',
        hop: currentHop + toClaim.length + 1,
      })
      toClaim.push(candidate)
    }

    if (toClaim.length === 0 && remainingSlots > 0 && currentHop >= maxHops) {
      await haltDispatcher({
        hop: currentHop,
        maxHops,
        targetNumber: frontier[0]?.number,
        eventLog,
        notifier,
      })
      return {
        halted: true,
        frontierIssues: frontier.map((i) => i.number),
        dispatchedDinesh,
        dispatchedGilfoyle,
        transitionedToReview,
        errors,
      }
    }

    const dineshOutcomes = await Promise.all(
      toClaim.map(async (issue) => {
        currentHop += 1
        const runHop = currentHop
        dispatchedDinesh.push(issue.number)
        try {
          const result = await runRole({
            repoRoot,
            config,
            roleName: 'dinesh',
            target: `#${issue.number}`,
            resolveAdapter,
            worktreeBaseDir: input.worktreeBaseDir,
            baseBranch: input.baseBranch,
            timeoutMs: input.timeoutMs,
            github,
            eventLog,
            notifier,
            hop: runHop,
          })
          return { issue, result, error: undefined }
        } catch (error) {
          return {
            issue,
            result: undefined,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )

    // Step 3: For Dinesh runs that opened a PR, transition to in-review and trigger Gilfoyle.
    for (const outcome of dineshOutcomes) {
      if (outcome.error) {
        errors.push(outcome.error)
        continue
      }
      const prNum = outcome.result?.pullRequestNumber
      if (prNum === undefined || reviewedPrsThisCycle.has(prNum)) {
        continue
      }
      const transitioned = await transitionIssueToReview(github, outcome.issue, eventLog, currentHop)
      if (transitioned) {
        transitionedToReview.push(outcome.issue.number)
      }
      if (!config.roles.gilfoyle) continue

      if (currentHop >= maxHops) {
        await haltDispatcher({
          hop: currentHop,
          maxHops,
          targetNumber: outcome.issue.number,
          eventLog,
          notifier,
        })
        return {
          halted: true,
          frontierIssues: frontier.map((i) => i.number),
          dispatchedDinesh,
          dispatchedGilfoyle,
          transitionedToReview,
          errors,
        }
      }

      currentHop += 1
      try {
        await runRole({
          repoRoot,
          config,
          roleName: 'gilfoyle',
          target: `PR #${prNum}`,
          resolveAdapter,
          timeoutMs: input.timeoutMs,
          github,
          eventLog,
          notifier,
          hop: currentHop,
        })
        dispatchedGilfoyle.push(prNum)
        reviewedPrsThisCycle.add(prNum)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
  }

  return {
    halted: false,
    frontierIssues: frontier.map((i) => i.number),
    dispatchedDinesh,
    dispatchedGilfoyle,
    transitionedToReview,
    errors,
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Runs the stateless dispatcher in polling mode until aborted, halted, or `maxCycles` completes.
 */
export async function dispatchPoll(input: DispatchPollInput): Promise<DispatchOnceResult[]> {
  const intervalMs =
    input.intervalMs ?? input.config.runtime.dispatcher.pollIntervalSec * 1000
  const results: DispatchOnceResult[] = []
  let cycle = 0

  while (!input.signal?.aborted) {
    if (input.maxCycles !== undefined && cycle >= input.maxCycles) {
      break
    }
    cycle += 1
    const res = await dispatchOnce(input)
    results.push(res)
    input.onCycle?.(res, cycle)

    if (res.halted) {
      break
    }
    if (input.maxCycles !== undefined && cycle >= input.maxCycles) {
      break
    }
    await sleep(intervalMs, input.signal)
  }

  return results
}

export function resolveDefaultEventLogPath(repoRoot: string, configuredPath: string): string {
  return path.resolve(repoRoot, configuredPath)
}
