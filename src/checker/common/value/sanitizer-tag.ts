/**
 *
 */
class SanitizerTagValue {
  id: string | undefined

  sanitizerType: string | undefined

  sanitizerScenario: string | undefined

  callstack: any[] | undefined

  node: any
}

module.exports = SanitizerTagValue
