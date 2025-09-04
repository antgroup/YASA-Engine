/**
 *
 */
class SanitizerResult {
  id

  type

  sanitizerType

  fileName

  beginLine

  endLine

  beginColumn

  endColumn

  codeSnippet

  callstackElements
}

module.exports = SanitizerResult
