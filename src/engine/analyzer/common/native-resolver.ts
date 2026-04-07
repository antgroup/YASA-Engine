const util = require('util')
const logger = require('../../../util/logger')(__filename)
const {
  ValueUtil: { PrimitiveValue },
} = require('../../util/value-util')
const ASTUtil = require('../../../util/ast-util')
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
function mkLiteral(v: any, parent: any): any {
  let res
  switch (typeof v) {
    case 'function':
      res = { ast: v, parent }
      break
    default:
      res = new PrimitiveValue(parent.qid, ASTUtil.prettyPrint(v), v, null, 'Literal')
      res.parent = parent
  }
  return res
}

//* ***************************** native calls **************************************

/**
 * native support for built-in functions
 * @param obj
 * @param f
 * @param argvalues
 * @returns {*}
 */
function nativeCall(obj: any, f: any, argvalues: any[]): any {
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

    const args: any[] = []
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
function processNativeFunction(this: any, node: any, fclos: any, argvalues: any[], state: any): any {
  if (!fclos.sid) return

  const { parent } = fclos
  if (!parent) return

  // array related native functions
  try {
    const res = nativeCall(parent, fclos.ast?.node, argvalues)
    if (res) return res
  } catch (e) {}

  switch (fclos.sid) {
    case '__delete__': {
      const cval = argvalues[0] // container value
      const key: any = argvalues[1] // key
      // TODO: implement _removeMemberValueDirect
      this._removeMemberValueDirect(cval, key, state)
      break
    }
  }

  // other native functions, e.g. global functions
  switch (parent.sid) {
    case 'Array': {
      switch (fclos.sid) {
        case 'isArray': {
          const val = argvalues.length == 0 ? false : Array.isArray(argvalues[0])
          return new PrimitiveValue(parent.qid, '<isArray_res>', val, null, 'Literal')
        }
      }
      break
    }
    case '__': {
      const fid = fclos.sid
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
  processNativeFunction,
}
