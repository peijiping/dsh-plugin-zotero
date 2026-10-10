import type {Context} from '@deepseek-ai/cordis'
import {defineTool} from '@deepseek-ai/dsh-tools'

export const name:string = 'greet-tool'
export const inject=['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name:'greet',
    description:'Greet someone by name.',
    parameters:{
      name:{type:'string',required:true,description: 'The name to greet'},
    },
    output:{
        schema:{type:'string'},
        render:(_args,value) => [{type:'text',text:value}]
    },
    async execute(args){
      return `Hello, ${args.name}!`
    },
  }))
}
