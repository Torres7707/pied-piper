import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AdapterUsage } from './adapters.js'
import type { AdapterType } from './config.js'

export type EventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'label.transitioned'
  | 'review.invalid'
  | 'review.escalated'
  | 'dispatcher.halted'
  | 'notification.sent'

export type EventStatus = 'started' | 'ok' | 'failed' | 'halted' | 'invalid'

export interface EventLogEntry {
  timestamp: string
  type: EventType
  role?: string
  target?: string
  adapter?: AdapterType
  model?: string
  status?: EventStatus
  usage?: AdapterUsage
  decision?: string
  sessionId?: string
  pullRequestNumber?: number
  hop?: number
  fromLabel?: string
  toLabel?: string
  error?: string
}

/** Append-only event log seam for retrospective execution tracing. */
export interface EventLog {
  readonly path: string
  append(entry: EventLogEntry): Promise<void>
  readEvents(): Promise<EventLogEntry[]>
}

/**
 * Creates a local append-only JSONL event log. Missing directories/files are created automatically.
 */
export function createJsonlEventLog(filePath: string): EventLog {
  const resolvedPath = path.resolve(filePath)

  return {
    path: resolvedPath,

    async append(entry: EventLogEntry): Promise<void> {
      await mkdir(path.dirname(resolvedPath), { recursive: true })
      const line = `${JSON.stringify(entry)}\n`
      await appendFile(resolvedPath, line, 'utf8')
    },

    async readEvents(): Promise<EventLogEntry[]> {
      let raw: string
      try {
        raw = await readFile(resolvedPath, 'utf8')
      } catch {
        return []
      }

      const entries: EventLogEntry[] = []
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          entries.push(JSON.parse(trimmed) as EventLogEntry)
        } catch {
          // Ignore partially written/corrupt trailing lines so recovery remains resilient.
        }
      }
      return entries
    },
  }
}
