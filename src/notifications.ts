import { spawn } from 'node:child_process'
import type { NotificationsConfig } from './config.js'
import type { GitHubPort } from './github.js'

export interface DesktopNotificationPayload {
  title: string
  body: string
}

export type DesktopSender = (payload: DesktopNotificationPayload) => Promise<void>

export interface NotificationMessage {
  title: string
  body: string
  reason: string
  targetNumber?: number
}

/** Configurable developer notification seam (desktop and/or GitHub @mention). */
export interface Notifier {
  notify(message: NotificationMessage): Promise<void>
}

export interface CreateNotifierOptions {
  config: NotificationsConfig
  github?: GitHubPort
  desktopSender?: DesktopSender
}

function spawnDetachedBestEffort(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        shell: false,
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', () => resolve())
      child.unref()
      resolve()
    } catch {
      resolve()
    }
  })
}

/**
 * Default non-blocking OS desktop notification sender using `shell: false` argument arrays.
 */
export function createDefaultDesktopSender(): DesktopSender {
  return async (payload: DesktopNotificationPayload): Promise<void> => {
    if (process.platform === 'darwin') {
      await spawnDetachedBestEffort('osascript', [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 1 of argv) with title (item 2 of argv)',
        '-e',
        'end run',
        payload.body,
        payload.title,
      ])
      return
    }
    if (process.platform === 'linux') {
      await spawnDetachedBestEffort('notify-send', [payload.title, payload.body])
    }
  }
}

/**
 * Creates a configurable notifier supporting desktop alerts, GitHub `@` mentions, both, or silent.
 */
export function createNotifier(options: CreateNotifierOptions): Notifier {
  const { config, github } = options
  const desktopSender = options.desktopSender ?? createDefaultDesktopSender()

  return {
    async notify(message: NotificationMessage): Promise<void> {
      if (config.desktop) {
        await desktopSender({
          title: message.title,
          body: message.body,
        })
      }

      if (config.githubMention && github && message.targetNumber !== undefined) {
        const handle = config.githubHandle.replace(/^@+/, '').trim()
        if (handle.length > 0) {
          const commentBody = `@${handle} **${message.title}** (${message.reason})\n\n${message.body}`
          await github.addIssueComment(message.targetNumber, commentBody)
        }
      }
    },
  }
}
