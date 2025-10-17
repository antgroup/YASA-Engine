const config = require('../config')
const logger = require('./logger')()
const { handleException } = require('../engine/analyzer/common/exception-handler')

const ErrorCode = {
  normal: 0,

  no_valid_source_file: 11,
  fail_to_parse: 12,
  fail_to_generate_report: 13,

  engine_failure: 20,
  engine_timeout: 21,

  unknown_error: 30,

  toString(code) {
    switch (code) {
      case 11:
        return 'no valid source file is found within the given directory'
      case 12:
        return 'fail to parse some source files'
      case 13:
        return 'fail to generate finding report and outputs for this scan'
      case 20:
        return 'uncaught/unprocessed exception happens in the analyzer'
      case 21:
        return 'the analyzer times out, e.g. got stuck in infinite loop'
      case 30:
        return 'an unknown error occurs'
    }
  },
}

/**
 *
 */
class BaseError extends Error {
  /**
   *
   * @param message
   */
  constructor(message) {
    super(message)
    this.description = ''
    this.code = 0
    this.assertable = false
  }
}

const Errors = {
  TypeError: genClass({
    name: 'TypeError',
    code: 0x11,
    description: 'TypeError',
    error_tolerance_factor: 0,
  }),
  TimeoutError: genClass({
    name: 'TimeoutError',
    code: 0x12,
    description: 'the analyzer times out, e.g. got stuck in infinite loop',
    error_tolerance_factor: 4,
  }),
  ParseError: genClass({
    name: 'ParseError',
    code: 0x13,
    description: 'failed to parse the file',
    error_tolerance_factor: 7,
  }),
  NoCompileUnitError: genClass({
    name: 'NoCompileUnitError',
    code: 0x14,
    description: 'find no target compileUnit of the project',
    error_tolerance_factor: 7,
  }),
  CheckerError: genClass({
    name: 'CheckerError',
    code: 0x15,
    description: '',
    error_tolerance_factor: 4,
  }),
  UnsupportedOperator: genClass({
    name: 'UnsupportedOperator',
    code: 0x16,
    description: '',
    error_tolerance_factor: 4,
  }),
  UnexpectedValue: genClass({
    name: 'UnexpectedValue',
    code: 0x17,
    description: 'UnexpectedValue',
    error_tolerance_factor: 7,
  }),
  UnexpectedNode: genClass({
    name: 'UnexpectedNode',
    code: 0x18,
    description: 'UnexpectedNode',
    error_tolerance_factor: 7,
  }),
  IllegalUse: genClass({
    name: 'IllegalUse',
    code: 0x50,
    description: 'IllegalUse',
    error_tolerance_factor: 4,
  }),
  EngineError: genClass({
    name: 'EngineError',
    code: 0x51,
    description: 'EngineError',
    error_tolerance_factor: 7,
  }),
  UnknownError: genClass({
    name: 'UnknownError',
    code: 0xf0,
    description: 'an unknown error occurs',
    error_tolerance_factor: 10,
  }),
}

/**
 *
 * @param err
 * @returns {(function(*, *?, *?): (*|undefined))|*}
 */
function genClass(err) {
  /**
   *
   */
  class _Err extends BaseError {
    /**
     *
     * @param message
     */
    constructor(message) {
      super(message)
      this.name = err.name
      this.code = err.code
      this.description = err.description
      this.message = message || err.description
      this.assertable = err.assertable
      this.error_tolerance_factor = err.error_tolerance_factor
    }

    /**
     *
     */
    toString() {
      return this.message === this.description ? this.message : `${this.description} : ${this.message}`
    }
  }

  return (message, headMsg, opts) => {
    if (typeof headMsg === 'object') {
      opts = headMsg
      headMsg = null
    }
    if (opts?.no_throw) {
      try {
        return handleError(new _Err(message), headMsg)
      } catch (e) {
        handleException(e, err.toString(), err.toString())
        return e
      }
    } else {
      handleError(new _Err(message), headMsg)
    }
  }
}

/**
 *
 * @param err
 * @param headMsg
 */
function handleError(err, headMsg) {
  if (headMsg && typeof headMsg.trim === 'function' && headMsg.trim() !== '') {
    const errMsgFunc = err.toString
    err.toString = () => `${headMsg}: ${errMsgFunc.apply(err)}`
  }
  if (!errorTolerance(err)) {
    throw err
  } else {
    handleException(err, err.toString(), err.toString())
  }
  return err
}

/**
 *
 * @param err
 */
function errorTolerance(err) {
  const builtin_error_report = !(err instanceof BaseError) && config.error_tolerance_factor <= 6
  const base_error_report = err instanceof BaseError && err.error_tolerance_factor < config.error_tolerance_factor

  return !(builtin_error_report || base_error_report)
}

module.exports = {
  Errors,
  ErrorCode,
  BaseError,
}
