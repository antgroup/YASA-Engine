/**
 *
 */
class SanitizerCallstackElementValue {
  id: string | undefined

  fileName: string | undefined

  beginLine: number | undefined

  endLine: number | undefined

  beginColumn: number | undefined

  endColumn: number | undefined

  codeSnippet: string | undefined
}

module.exports = SanitizerCallstackElementValue
