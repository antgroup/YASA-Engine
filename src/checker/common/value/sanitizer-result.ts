/**
 *
 */
class SanitizerResultValue {
  id: string | undefined

  type: string | undefined

  sanitizerType: string | undefined

  fileName: string | undefined

  beginLine: number | undefined

  endLine: number | undefined

  beginColumn: number | undefined

  endColumn: number | undefined

  codeSnippet: string | undefined

  callstackElements: any[] | undefined
}

module.exports = SanitizerResultValue
