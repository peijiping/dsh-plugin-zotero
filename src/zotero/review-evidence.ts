import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ZoteroError } from './client.js'
import {
  isReviewEvidenceId,
  isReviewEvidenceRun,
  REVIEW_FRAGMENT_MAX,
  type ReviewEvidenceRecord,
} from './review-evidence-types.js'

export function requireReviewRun(run: unknown): string {
  if (!isReviewEvidenceRun(run)) throw new ZoteroError('bad_request', '无效的综述编号')
  return run
}

export function requireReviewEvidenceId(id: unknown): string {
  if (!isReviewEvidenceId(id)) throw new ZoteroError('bad_request', '无效的证据编号')
  return id
}

function directory(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-plugin-zotero', 'review-evidence')
}

async function readReview(run: string): Promise<string | null> {
  try {
    return await readFile(join(directory(), `${requireReviewRun(run)}.json`), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parseRecords(value: unknown): ReviewEvidenceRecord[] {
  if (!Array.isArray(value) || value.length === 0) throw new ZoteroError('bad_request', '缺少综述证据')
  const ids = new Set<string>()
  return value.map((entry) => {
    const { id, key, attachmentKey, revision, start, end, excerpt } = (entry ?? {}) as Partial<ReviewEvidenceRecord>
    if (!isReviewEvidenceId(id) || ids.has(id)
      || typeof key !== 'string' || !/^[A-Z2-9]{8}$/u.test(key)
      || typeof attachmentKey !== 'string' || !/^[A-Z2-9]{8}$/u.test(attachmentKey)
      || typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision)
      || typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0
      || typeof end !== 'number' || !Number.isSafeInteger(end) || end <= start
      || typeof excerpt !== 'string' || excerpt.length !== end - start || excerpt.length > REVIEW_FRAGMENT_MAX
      || excerpt.trim() === '') {
      throw new ZoteroError('bad_request', '无效的综述证据记录')
    }
    ids.add(id)
    return { id, key, attachmentKey, revision, start, end, excerpt }
  })
}

/** Publish a complete index once. Retrying the same draft is safe across concurrent hosts. */
export async function saveReviewEvidence(run: string, value: unknown): Promise<void> {
  requireReviewRun(run)
  const data = JSON.stringify(parseRecords(value))
  const existing = await readReview(run)
  if (existing === data) return
  const folder = directory()
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const temp = join(folder, `${randomUUID()}.tmp`)
  try {
    await writeFile(temp, data, { flag: 'wx', mode: 0o600 })
    await link(temp, join(folder, `${run}.json`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await readReview(run) !== data) throw new ZoteroError('bad_request', '综述编号已绑定到不同的证据')
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

export async function getReviewEvidence(run: string, id: string): Promise<ReviewEvidenceRecord | null> {
  requireReviewEvidenceId(id)
  const raw = await readReview(run)
  if (raw === null) return null
  const records: ReviewEvidenceRecord[] = JSON.parse(raw)
  return records.find((entry) => entry.id === id) ?? null
}
