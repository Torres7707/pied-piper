import { randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AdapterResolver } from './adapters.js'
import type { PiedPiperConfig } from './config.js'
import type { EventLog } from './event-log.js'
import type { GitHubIssue, GitHubPort, GitHubPullRequest, GitHubReview } from './github.js'
import type { Notifier } from './notifications.js'
import {
  formatBlockingFindingsContext,
  validateGilfoyleOutput,
  type ReviewFinding,
  type ReviewValidationResult,
} from './review.js'
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
  escalatedToHuman: number[]
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

async function setIssueLabelState(params: {
  github: GitHubPort
  issue: GitHubIssue
  add: string[]
  remove: string[]
  decision: string
  eventLog?: EventLog
  hop?: number
}): Promise<boolean> {
  const { github, issue, add, remove, decision, eventLog, hop } = params
  const toRemove = remove.filter((l) => issue.labels.includes(l))
  const toAdd = add.filter((l) => !issue.labels.includes(l))
  if (toRemove.length === 0 && toAdd.length === 0) {
    return false
  }
  if (toRemove.length > 0) {
    await github.removeLabels(issue.number, toRemove)
    const removeSet = new Set(toRemove)
    issue.labels = issue.labels.filter((l) => !removeSet.has(l))
  }
  if (toAdd.length > 0) {
    await github.addLabels(issue.number, toAdd)
    issue.labels.push(...toAdd)
  }
  await eventLog?.append({
    timestamp: new Date().toISOString(),
    type: 'label.transitioned',
    target: `#${issue.number}`,
    fromLabel: toRemove.join(',') || undefined,
    toLabel: toAdd.join(',') || undefined,
    decision,
    hop,
  })
  return true
}

async function escalateToHuman(params: {
  github: GitHubPort
  linkedIssues: GitHubIssue[]
  prNumber: number
  reason: string
  body: string
  eventType: 'review.escalated' | 'review.invalid'
  eventLog?: EventLog
  notifier?: Notifier
  hop: number
  escalatedToHuman: number[]
}): Promise<void> {
  const {
    github,
    linkedIssues,
    prNumber,
    reason,
    body,
    eventType,
    eventLog,
    notifier,
    hop,
    escalatedToHuman,
  } = params

  for (const issue of linkedIssues) {
    await setIssueLabelState({
      github,
      issue,
      add: ['ready-for-human'],
      remove: ['in-review', 'in-progress'],
      decision: reason,
      eventLog,
      hop,
    })
    escalatedToHuman.push(issue.number)
  }

  await eventLog?.append({
    timestamp: new Date().toISOString(),
    type: eventType,
    target: `PR #${prNumber}`,
    status: eventType === 'review.invalid' ? 'invalid' : 'halted',
    decision: reason,
    pullRequestNumber: prNumber,
    hop,
  })

  await notifier?.notify({
    title: `Pied Piper needs developer decision (PR #${prNumber})`,
    body,
    reason,
    targetNumber: linkedIssues[0]?.number ?? prNumber,
  })
}

async function writeBlockingFindingsFile(
  repoRoot: string,
  prNumber: number,
  findings: ReviewFinding[],
): Promise<string> {
  const dir = path.join(repoRoot, '.piedpiper', 'tmp', `review-${prNumber}-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `pr-${prNumber}-round-1-blocking-findings.md`)
  await writeFile(filePath, formatBlockingFindingsContext(prNumber, findings), 'utf8')
  await chmod(filePath, 0o444)
  return filePath
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

function interpretReviewBody(body: string, validateOutput: boolean): ReviewValidationResult {
  const parsed = validateGilfoyleOutput(body)
  if (!validateOutput) {
    return {
      valid: true,
      approved: parsed.blockingFindings.length === 0,
      blockingFindings: parsed.blockingFindings,
      advisoryFindings: parsed.advisoryFindings,
    }
  }
  return parsed
}

interface ValidatedGilfoyleAttempt {
  halted: boolean
  valid: boolean
  reply?: string
  validation?: ReviewValidationResult
  hop: number
  error?: string
}

async function runGilfoyleWithValidation(params: {
  input: DispatchOnceInput
  prNumber: number
  linkedIssues: GitHubIssue[]
  round: number
  extraContextPaths?: string[]
  extraInstructions?: string[]
  hop: number
  escalatedToHuman: number[]
}): Promise<ValidatedGilfoyleAttempt> {
  const { input, prNumber, linkedIssues, round, extraContextPaths, extraInstructions, escalatedToHuman } =
    params
  const { repoRoot, config, github, resolveAdapter, eventLog, notifier } = input
  const maxHops = config.runtime.dispatcher.maxHops
  const validateOutput = config.runtime.review.validateOutput
  let hop = params.hop

  const maxAttempts = validateOutput ? 2 : 1
  let lastReason = 'Invalid Gilfoyle review output'

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (hop >= maxHops) {
      await haltDispatcher({
        hop,
        maxHops,
        targetNumber: linkedIssues[0]?.number ?? prNumber,
        eventLog,
        notifier,
      })
      return { halted: true, valid: false, hop }
    }

    hop += 1
    const attemptInstructions = [
      ...(extraInstructions ?? []),
      ...(attempt > 1
        ? [
            'Previous output failed structural validation. You MUST provide at least one concrete finding (file:line, rationale, [阻塞级]/[建议级]) OR an explicit justified approval with checked file scope and acceptance criteria.',
          ]
        : []),
    ]

    let reply: string
    try {
      const result = await runRole({
        repoRoot,
        config,
        roleName: 'gilfoyle',
        target: `PR #${prNumber}`,
        resolveAdapter,
        timeoutMs: input.timeoutMs,
        github,
        publishReview: false,
        extraContextPaths,
        extraInstructions: attemptInstructions.length > 0 ? attemptInstructions : undefined,
        eventLog,
        notifier,
        hop,
      })
      reply = result.reply
    } catch (error) {
      return {
        halted: false,
        valid: false,
        hop,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const validation = interpretReviewBody(reply, validateOutput)
    if (validation.valid) {
      await github.submitPullRequestReview(prNumber, {
        body: reply,
        event: validation.blockingFindings.length > 0 ? 'REQUEST_CHANGES' : 'COMMENT',
      })
      return { halted: false, valid: true, reply, validation, hop }
    }

    lastReason = validation.reason ?? lastReason
    await eventLog?.append({
      timestamp: new Date().toISOString(),
      type: 'review.invalid',
      role: 'gilfoyle',
      target: `PR #${prNumber}`,
      status: 'invalid',
      decision: `round=${round} attempt=${attempt}: ${lastReason}`,
      pullRequestNumber: prNumber,
      hop,
    })
  }

  await escalateToHuman({
    github,
    linkedIssues,
    prNumber,
    reason: `invalid_review_output: ${lastReason}`,
    body: `Gilfoyle round ${round} output failed validation after retries: ${lastReason}`,
    eventType: 'review.invalid',
    eventLog,
    notifier,
    hop,
    escalatedToHuman,
  })
  return { halted: false, valid: false, hop }
}

async function processPrReviewLoop(params: {
  input: DispatchOnceInput
  pr: GitHubPullRequest
  linkedIssues: GitHubIssue[]
  hop: number
  dispatchedDinesh: number[]
  dispatchedGilfoyle: number[]
  transitionedToReview: number[]
  escalatedToHuman: number[]
  errors: string[]
}): Promise<{ halted: boolean; hop: number }> {
  const {
    input,
    pr,
    linkedIssues,
    dispatchedDinesh,
    dispatchedGilfoyle,
    transitionedToReview,
    escalatedToHuman,
    errors,
  } = params
  const { repoRoot, config, github, resolveAdapter, eventLog, notifier } = input
  const maxRounds = config.runtime.review.maxRounds
  const maxHops = config.runtime.dispatcher.maxHops
  const validateOutput = config.runtime.review.validateOutput
  let hop = params.hop

  if (linkedIssues.some((i) => i.labels.includes('ready-for-human'))) {
    return { halted: false, hop }
  }

  const existingReviews: GitHubReview[] = await github.listPullRequestReviews(pr.number)

  // Already reviewed at least once: decide whether it's approved, awaiting Round 2, or ready to escalate.
  if (existingReviews.length > 0) {
    const latest = existingReviews.at(-1)!
    const latestParsed = interpretReviewBody(latest.body, validateOutput)
    if (latestParsed.blockingFindings.length === 0) {
      return { halted: false, hop }
    }

    if (existingReviews.length >= maxRounds) {
      await escalateToHuman({
        github,
        linkedIssues,
        prNumber: pr.number,
        reason: `blocking_findings_after_${existingReviews.length}_rounds`,
        body: `PR #${pr.number} still has ${latestParsed.blockingFindings.length} blocking finding(s) after ${existingReviews.length} review rounds.`,
        eventType: 'review.escalated',
        eventLog,
        notifier,
        hop,
        escalatedToHuman,
      })
      return { halted: false, hop }
    }

    // Round 1 had blocking findings and we have not run Round 2 yet.
    const blockingFile = await writeBlockingFindingsFile(
      repoRoot,
      pr.number,
      latestParsed.blockingFindings,
    )

    // If any linked issue is still in-progress, run Dinesh fix first before Round 2 review.
    const needsDineshFix = linkedIssues.some((i) => i.labels.includes('in-progress'))
    if (needsDineshFix && config.roles.dinesh && linkedIssues[0]) {
      if (hop >= maxHops) {
        await haltDispatcher({
          hop,
          maxHops,
          targetNumber: linkedIssues[0].number,
          eventLog,
          notifier,
        })
        return { halted: true, hop }
      }
      hop += 1
      dispatchedDinesh.push(linkedIssues[0].number)
      try {
        await runRole({
          repoRoot,
          config,
          roleName: 'dinesh',
          target: `#${linkedIssues[0].number}`,
          resolveAdapter,
          worktreeBaseDir: input.worktreeBaseDir,
          baseBranch: input.baseBranch,
          timeoutMs: input.timeoutMs,
          github,
          extraContextPaths: [blockingFile],
          extraInstructions: [
            'Address ONLY the Round 1 blocking findings listed in the context file and commit updates to the PR branch.',
          ],
          eventLog,
          notifier,
          hop,
        })
        for (const issue of linkedIssues) {
          const moved = await setIssueLabelState({
            github,
            issue,
            add: ['in-review'],
            remove: ['in-progress'],
            decision: 'round1_fixes_pushed',
            eventLog,
            hop,
          })
          if (moved) transitionedToReview.push(issue.number)
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        return { halted: false, hop }
      }
    }

    if (!config.roles.gilfoyle) return { halted: false, hop }
    const round2 = await runGilfoyleWithValidation({
      input,
      prNumber: pr.number,
      linkedIssues,
      round: existingReviews.length + 1,
      extraContextPaths: [blockingFile],
      extraInstructions: [
        'Review Round 2: Verify ONLY whether the Round 1 blocking findings in the context file have been resolved (and check direct regressions). Do not expand scope.',
      ],
      hop,
      escalatedToHuman,
    })
    hop = round2.hop
    if (round2.error) errors.push(round2.error)
    if (round2.halted) return { halted: true, hop }
    if (round2.valid) {
      dispatchedGilfoyle.push(pr.number)
      if ((round2.validation?.blockingFindings.length ?? 0) > 0 && existingReviews.length + 1 >= maxRounds) {
        await escalateToHuman({
          github,
          linkedIssues,
          prNumber: pr.number,
          reason: `blocking_findings_after_${maxRounds}_rounds`,
          body: `PR #${pr.number} still has blocking findings after Round ${maxRounds}. Manual developer decision required.`,
          eventType: 'review.escalated',
          eventLog,
          notifier,
          hop,
          escalatedToHuman,
        })
      }
    }
    return { halted: false, hop }
  }

  // Round 1: PR has 0 reviews yet. Ensure linked issues are marked in-review, then run Gilfoyle.
  for (const issue of linkedIssues) {
    const moved = await setIssueLabelState({
      github,
      issue,
      add: ['in-review'],
      remove: ['in-progress'],
      decision: 'pr_opened',
      eventLog,
      hop,
    })
    if (moved) transitionedToReview.push(issue.number)
  }

  if (!config.roles.gilfoyle) return { halted: false, hop }

  const round1 = await runGilfoyleWithValidation({
    input,
    prNumber: pr.number,
    linkedIssues,
    round: 1,
    hop,
    escalatedToHuman,
  })
  hop = round1.hop
  if (round1.error) errors.push(round1.error)
  if (round1.halted) return { halted: true, hop }
  if (!round1.valid || !round1.validation) return { halted: false, hop }

  dispatchedGilfoyle.push(pr.number)

  // Approved or advisory-only -> end automatic loop without merging.
  if (round1.validation.blockingFindings.length === 0) {
    return { halted: false, hop }
  }

  if (maxRounds <= 1) {
    await escalateToHuman({
      github,
      linkedIssues,
      prNumber: pr.number,
      reason: 'blocking_findings_after_1_round',
      body: `PR #${pr.number} has blocking findings and maxRounds=1.`,
      eventType: 'review.escalated',
      eventLog,
      notifier,
      hop,
      escalatedToHuman,
    })
    return { halted: false, hop }
  }

  // Round 1 blocking findings -> send back to Dinesh for targeted fix, then run Round 2 Gilfoyle.
  const blockingFile = await writeBlockingFindingsFile(
    repoRoot,
    pr.number,
    round1.validation.blockingFindings,
  )

  if (config.roles.dinesh && linkedIssues[0]) {
    if (hop >= maxHops) {
      await haltDispatcher({
        hop,
        maxHops,
        targetNumber: linkedIssues[0].number,
        eventLog,
        notifier,
      })
      return { halted: true, hop }
    }

    for (const issue of linkedIssues) {
      await setIssueLabelState({
        github,
        issue,
        add: ['in-progress'],
        remove: ['in-review'],
        decision: 'round1_blocking_findings',
        eventLog,
        hop,
      })
    }

    hop += 1
    dispatchedDinesh.push(linkedIssues[0].number)
    try {
      await runRole({
        repoRoot,
        config,
        roleName: 'dinesh',
        target: `#${linkedIssues[0].number}`,
        resolveAdapter,
        worktreeBaseDir: input.worktreeBaseDir,
        baseBranch: input.baseBranch,
        timeoutMs: input.timeoutMs,
        github,
        extraContextPaths: [blockingFile],
        extraInstructions: [
          'Address ONLY the Round 1 blocking findings listed in the context file and commit updates to the PR branch.',
        ],
        eventLog,
        notifier,
        hop,
      })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      return { halted: false, hop }
    }

    for (const issue of linkedIssues) {
      const moved = await setIssueLabelState({
        github,
        issue,
        add: ['in-review'],
        remove: ['in-progress'],
        decision: 'round1_fixes_pushed',
        eventLog,
        hop,
      })
      if (moved) transitionedToReview.push(issue.number)
    }
  }

  const round2 = await runGilfoyleWithValidation({
    input,
    prNumber: pr.number,
    linkedIssues,
    round: 2,
    extraContextPaths: [blockingFile],
    extraInstructions: [
      'Review Round 2: Verify ONLY whether the Round 1 blocking findings in the context file have been resolved (and check direct regressions). Do not expand scope.',
    ],
    hop,
    escalatedToHuman,
  })
  hop = round2.hop
  if (round2.error) errors.push(round2.error)
  if (round2.halted) return { halted: true, hop }
  if (round2.valid) {
    dispatchedGilfoyle.push(pr.number)
    if ((round2.validation?.blockingFindings.length ?? 0) > 0 && 2 >= maxRounds) {
      await escalateToHuman({
        github,
        linkedIssues,
        prNumber: pr.number,
        reason: `blocking_findings_after_${maxRounds}_rounds`,
        body: `PR #${pr.number} still has blocking findings after ${maxRounds} review rounds. Manual developer decision required.`,
        eventType: 'review.escalated',
        eventLog,
        notifier,
        hop,
        escalatedToHuman,
      })
    }
  }

  return { halted: false, hop }
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
      escalatedToHuman: [],
      errors: [],
    }
  }

  const dispatchedDinesh: number[] = []
  const dispatchedGilfoyle: number[] = []
  const transitionedToReview: number[] = []
  const escalatedToHuman: number[] = []
  const errors: string[] = []
  const processedPrsThisCycle = new Set<number>()

  // Step 1: Process existing open PRs (review transitions, Round 1/2 loop, and escalation).
  for (const pr of openPrs) {
    const linkedIssues = pr.linkedIssueNumbers
      .map((num) => issueByNumber.get(num))
      .filter((issue): issue is GitHubIssue => issue !== undefined)

    processedPrsThisCycle.add(pr.number)
    const outcome = await processPrReviewLoop({
      input,
      pr,
      linkedIssues,
      hop: currentHop,
      dispatchedDinesh,
      dispatchedGilfoyle,
      transitionedToReview,
      escalatedToHuman,
      errors,
    })
    currentHop = outcome.hop
    if (outcome.halted) {
      return {
        halted: true,
        frontierIssues: frontier.map((i) => i.number),
        dispatchedDinesh,
        dispatchedGilfoyle,
        transitionedToReview,
        escalatedToHuman,
        errors,
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
      await setIssueLabelState({
        github,
        issue: candidate,
        add: ['in-progress'],
        remove: [],
        decision: 'claimed_frontier',
        eventLog,
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
        escalatedToHuman,
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

    // Step 3: For newly opened PRs, transition to in-review and drive the bounded review loop.
    for (const outcome of dineshOutcomes) {
      if (outcome.error) {
        errors.push(outcome.error)
        continue
      }
      const prNum = outcome.result?.pullRequestNumber
      if (prNum === undefined || processedPrsThisCycle.has(prNum)) {
        continue
      }
      processedPrsThisCycle.add(prNum)
      const pr = await github.getPullRequest(prNum)
      const loopResult = await processPrReviewLoop({
        input,
        pr,
        linkedIssues: [outcome.issue],
        hop: currentHop,
        dispatchedDinesh,
        dispatchedGilfoyle,
        transitionedToReview,
        escalatedToHuman,
        errors,
      })
      currentHop = loopResult.hop
      if (loopResult.halted) {
        return {
          halted: true,
          frontierIssues: frontier.map((i) => i.number),
          dispatchedDinesh,
          dispatchedGilfoyle,
          transitionedToReview,
          escalatedToHuman,
          errors,
        }
      }
    }
  }

  return {
    halted: false,
    frontierIssues: frontier.map((i) => i.number),
    dispatchedDinesh,
    dispatchedGilfoyle,
    transitionedToReview,
    escalatedToHuman,
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
