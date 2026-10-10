import type {Context} from '@deepseek-ai/cordis'

export const name:string = 'hello-plugin'

export function apply(ctx: Context) {
  console.log('[hello-plugin] hello from my first DSH plugin!')
}