/**
 *
 */
export interface Invocation {
  callSiteLiteral: string

  calleeType: string

  fsig: string

  argTypes: string[]

  callSite: any

  fromScope: any

  fromScopeAst: any

  toScope: any

  toScopeAst: any
}
