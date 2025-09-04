const util = require('util')
const _ = require('lodash')
const logger = require('../../../util/logger')(__filename)
const {
  ValueUtil: { PrimitiveValue },
} = require('../../util/value-util')
const { handleException } = require('./exception-handler')

/**
 * resolve native function calls (as in JIT evaluation)
 */

//* ***************************** utility **************************************

/**
 *
 * @param v
 * @param parent
 * @returns {{ast: *, parent: *}|{type: string, value: *}}
 */
function mkLiteral(v, parent) {
  let res
  switch (typeof v) {
    case 'function':
      res = { ast: v, parent }
      break
    default:
      res = PrimitiveValue({ type: 'Literal', value: v })
  }
  return res
}

//* ***************************** value simplifcation **************************************

/**
 * "-" | "+" | "!" | "~" | "typeof" | "void" | "delete"
 * @param exp
 * @returns {*}
 */
function simplifyUnaryExpression(exp) {
  const argument = exp.subExpression
  if (!argument) return exp

  if (Array.isArray(argument)) {
    switch (exp.operator) {
      case '!': {
        const newval = argument.length === 0
        return PrimitiveValue({ type: 'Literal', value: newval })
      }
    }
    return exp
  }
  if (exp.operator === '#') {
    // handle escaping
    switch (argument.type) {
      case 'Literal':
        return argument.value
      // should handle only literals; otherwise #id is resolved to a constant rather than an expression
      // case 'Identifier':
      //    return argument.name;
    }
  } else if (argument.type === 'Literal') {
    const val = argument.value
    let newval
    switch (exp.operator) {
      case '--': {
        newval = val - 1
        break
      }
      case '++': {
        newval = val + 1
        break
      }
      case '-': {
        newval = -val
        break
      }
      case '+': {
        newval = +val
        break
      }
      case '!': {
        newval = !val
        break
      }
      case '~': {
        newval = ~val
        break
      }
      default:
        return PrimitiveValue(exp)
    }
    if (val && val.hasTagRec) newval.hasTagRec = val.hasTagRec
    return PrimitiveValue({ type: 'Literal', value: newval })
  } else if (argument.vtype === 'object') {
    switch (exp.operator) {
      case '!': {
        const newval = _.isEmpty(argument.value)
        return PrimitiveValue({ type: 'Literal', value: newval })
      }
    }
    return exp
  }
  return exp
}

/**
 *
 * "==" | "!=" | "===" | "!==" | "<" | "<=" | ">" | ">=" | "<<" | ">>" | ">>>" |
 * "+" | "-" | "*" | "/" | "%" | "|" | "^" | "&" |
 * "&&" | "||"
 * @param exp
 * @returns {*}
 */
function simplifyBinaryExpression(exp) {
  // onsole.log("simplify: " + formatNode(exp));
  const { left } = exp
  const { right } = exp
  if (!left || !right || left.type !== 'Literal' || right.type !== 'Literal') return exp
  const lval = left.value
  const rval = right.value
  let newval
  switch (exp.operator) {
    case '+':
    case '+=': {
      newval = lval + rval
      break
    }
    case '-':
    case '-=': {
      newval = lval - rval
      break
    }
    case '*':
    case '*=': {
      newval = lval * rval
      break
    }
    case '/':
    case '/=': {
      newval = lval / rval
      break
    }
    case '%':
    case '%=': {
      newval = lval % rval
      break
    }
    case '|':
    case '|=': {
      newval = lval | rval
      break
    }
    case '^':
    case '^=': {
      newval = lval ^ rval
      break
    }
    case '&':
    case '&=': {
      newval = lval & rval
      break
    }

    case '<': {
      newval = lval < rval
      break
    }
    case '<=': {
      newval = lval <= rval
      break
    }
    case '>': {
      newval = lval > rval
      break
    }
    case '>=': {
      newval = lval >= rval
      break
    }
    case '<<':
    case '<<=': {
      newval = lval << rval
      break
    }
    case '>>':
    case '>>=': {
      newval = lval >> rval
      break
    }
    case '>>>':
    case '>>>=': {
      newval = lval >>> rval
      break
    }

    case '&&':
    case '&&=': {
      newval = lval && rval
      break
    }
    case '||':
    case '||=': {
      newval = lval || rval
      break
    }

    case '<': {
      newval = lval < rval
      break
    }
    case '<=': {
      newval = lval <= rval
      break
    }
    case '>=': {
      newval = lval >= rval
      break
    }
    case '>': {
      newval = lval > rval
      break
    }
    case '==': {
      newval = lval == rval
      break
    }
    case '!=': {
      newval = lval != rval
      break
    }
    case '&&':
    case '&&=': {
      newval = lval && rval
      break
    }
    case '||':
    case '||=': {
      newval = lval || rval
      break
    }

    default:
      return exp
  }

  return PrimitiveValue({ type: 'Literal', value: newval })
}

/**
 * c ? b1 : b2
 * @param exp
 * @returns {*}
 */
function simplifyConditionalExpression(exp) {
  // onsole.log("simplify: " + formatNode(exp));
  const { test } = exp
  if (!test || test.type !== 'Literal') return exp
  return test.value ? PrimitiveValue(exp.trueExpression) : PrimitiveValue(exp.falseExpression)
}

// ***

/**
 * e.g. accessing members in concrete objects
 * @param obj
 * @param index
 * @returns {{type: string, value: *}|*}
 */
function simplifyMemberAccess(obj, index) {
  switch (obj.type) {
    case 'Literal': {
      // let res = obj.raw[index];
      if (!obj.value) return // {type: "Literal", value: null};
      const res = obj.value[index]
      if (res) return mkLiteral(res, obj)
      break
    }
  }
}

/**
 * e.g. accessing members in concrete arrays
 * @param obj
 * @param index
 * @returns {*}
 */
function simplifyArrayExpression(obj, index) {
  try {
    switch (index) {
      case 'length': {
        const len = obj.length
        return PrimitiveValue({ type: 'Literal', value: len, raw: len })
      }
    }
    const res = obj[index] // return the value
    if (res) {
      if (typeof res === 'function') {
        return { ast: res, parent: obj }
      }
      return res
    }
  } catch (e) {}
}

//* ***************************** native calls **************************************

/**
 * native support for built-in functions
 * @param obj
 * @param f
 * @param argvalues
 * @returns {*}
 */
function nativeCall(obj, f, argvalues) {
  const fname = f.name
  // array operations
  if (Array.isArray(obj)) {
    switch (fname) {
      //     case 'slice':
      //     {
      //         const len = argvalues.length;
      //         if (len === 0) return argvalues;
      //         const begin = argvalues[0].value;
      //         if (!begin) return;
      //         if (len > 1) {
      //             let end = argvalues[1].value;
      //             if (!end) return;
      //             return obj.slice(begin, end);
      //         }
      //         else
      //             return obj.slice(begin);
      //     }
      //     case 'reverse':
      //     {
      //         return obj.reverse();
      //     }
      //     case 'concat':
      //     {
      //         return obj.concat(argvalues);
      //     }
      case 'push': {
        return obj.push(argvalues)
      }
      //     case 'pop':
      //     {
      //         return obj.pop();
      //     }
      //     case 'indexOf':
      //     {
      //         const i = obj.indexOf(argvalues[0]);
      //         return {type: 'Literal', value: i, raw: i};
      //     }
      //     case 'lastIndexOf':
      //     {
      //         const i = obj.lastIndexOf(argvalues[0]);
      //         return {type: 'Literal', value: i, raw: i};
      //     }
    }
  } else if (obj.type === 'Literal') {
    const val = obj.value

    const args = []
    for (let i = 0; i < argvalues.length; i++) {
      if (argvalues[i].type === 'Literal')
        args.push(argvalues[i].value) // not concrete value
      else return
    }

    const res = f.apply(val, args)
    if (res) return mkLiteral(res, val)
  }
}

//* ***************************** native calls **************************************

/**
 * process native functions
 * @param node
 * @param fclos
 * @param argvalues
 * @param state
 * @returns {*}
 */
function processNativeFunction(node, fclos, argvalues, state) {
  if (!fclos.id) return

  const { parent } = fclos
  if (!parent) return

  // array related native functions
  try {
    const res = nativeCall(parent, fclos.ast, argvalues)
    if (res) return res
  } catch (e) {}

  switch (fclos.id) {
    case '__delete__': {
      const cval = argvalues[0] // container value
      const key = argvalues[1] // key
      this._removeMemberValueDirect(cval, key, state)
    }
  }

  // other native functions, e.g. global functions
  switch (parent.id) {
    case 'Array': {
      switch (fclos.id) {
        case 'isArray': {
          const val = argvalues.length == 0 ? false : Array.isArray(argvalues[0])
          return PrimitiveValue({ type: 'Literal', value: val, raw: val })
        }
      }
      break
    }
    case '__': {
      const fid = fclos.id
      if (!fid) break
      switch (fid) {
        case 'log':
          // if (argvalues.length > 1 && argvalues[1].type === 'Literal')
          //     logger.info(util.inspect(argvalues[0], {depth: argvalues[1].value}));
          // else {
          for (const arg of argvalues) logger.info(util.inspect(arg, { depth: 6 }))
          // }
          return true
        case 'debug':
          return true
        case 'assertEqual':
          if (argvalues[0].value !== argvalues[1].value) {
            handleException(
              new Error('assertEqual fails!'),
              'Error in processNativeFunction,assertEqual fails!',
              'Error in processNativeFunction,assertEqual fails!'
            )
          }
          return true
      }
      if (fid.startsWith('print_')) {
        const fd = fid.substring(6)
        for (const arg of argvalues) logger.info(util.inspect(arg[fd], { depth: 6 }))
        return true
      }
    }
  }
}

// ***

module.exports = {
  simplifyUnaryExpression,
  simplifyBinaryExpression,
  simplifyMemberAccess,
  simplifyArrayExpression,
  simplifyConditionalExpression,

  processNativeFunction,
}
