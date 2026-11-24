const RUN = /^[a-f0-9]{24}$/u
const ID = /^Z[1-9]\d{0,5}\.[1-9]\d{0,5}$/u
export const REVIEW_FRAGMENT_MAX = 760

export interface ReviewEvidenceRecord {
  id: string
  key: string
  attachmentKey: string
  revision: string
  start: number
  end: number
  excerpt: string
}

export function isReviewEvidenceRun(run: unknown): run is string {
  return typeof run === 'string' && RUN.test(run)
}

export function isReviewEvidenceId(id: unknown): id is string {
  return typeof id === 'string' && ID.test(id)
}
