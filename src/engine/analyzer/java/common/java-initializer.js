const jsonfile = require('jsonfile')
const _ = require('lodash')
const {
  ValueUtil: { ObjectValue, FunctionValue, Scoped }, getValueFromPackageByQid,
} = require('../../../util/value-util')

const lombok = require('./builtins/lombok')
const { getValueFromTree } = require('../../../../util/common-util')
const config = require('../../../../config')
const { getAbsolutePath } = require('../../../../util/file-util')
const Scope = require('../../common/scope')
/**
 *
 */
class JavaInitializer {
  static builtin = {
    lombok,
  }

  /**
   * 1. builtin variables and constants for the top global
   *    like JSON, Math Reflect, console, etc.
   * 2. introduce taint
   *
   * @param global
   */
  static initGlobalScope(global) {
    JavaInitializer.initCommonGlobalBuiltin(global)
    JavaInitializer.initSpecialGlobalBuiltin(global)
  }

  /**
   * init package scope
   * @param scope
   */
  static initPackageScope(scope) {
    JavaInitializer.initCommonPackageBuiltin(scope)
    JavaInitializer.initSpecialPackageBuiltin(scope)
  }

  /**
   * builtin variables and constant for file
   * @param node
   * @param file
   * @param packageScope
   * @returns Unit
   */
  static initFileScope(node, file, packageScope) {
    // init for module
    // const modScope = {id:file, vtype: 'modScope', value:{}, closure:{}, decls:node, parent : this.topScope, fdef:node};
    if (!file) return
    const relateFileName = file.startsWith(config.maindirPrefix)
      ? file.substring(config.maindirPrefix.length).split('.')[0]
      : file.split('.')[0]
    const fileClos = Scoped({
      qid: packageScope.qid,
      sid: relateFileName,
      parent: packageScope,
      decls: {},
      fdef: node,
      ast: node,
    })
    fileClos._this = fileClos
    fileClos.isProcessed = false
    fileClos.exports = packageScope.exports

    return fileClos
  }

  /**
   *
   * @param packageName
   */
  static initInPackageScope(packageName) {
    const packageClos = Scoped({ sid: 'package', parent: this.topScope, decls: {} })
    packageClos._this = packageClos
    return packageClos
  }

  /**
   * modeling for base type and subtypes in java.lang
   * @param scope
   */
  static initCommonGlobalBuiltin(scope) {
    const filePath = getAbsolutePath('resource/java/class-hierarchy-and-modeling.json')
    const hierarchyObj = jsonfile.readFileSync(filePath)
    if (!hierarchyObj) {
      return
    }

    for (const baseType in hierarchyObj) {
      let StructCls
      try {
        const structPath = getAbsolutePath(hierarchyObj[baseType].modelingFilePath)
        StructCls = require(structPath)
      } catch (e) {
        continue
      }
      const methods = this.findAllStaticMethodOfClass(StructCls)

      const fullClassNames = []
      fullClassNames.push(baseType)
      if (hierarchyObj[baseType].subTypeList) {
        for (const subType of hierarchyObj[baseType].subTypeList) {
          fullClassNames.push(subType)
        }
      }

      let baseClsCtor = null
      for (const fullClassName of fullClassNames) {
        let packageName
        let className = fullClassName
        const lastDotIndex = fullClassName.lastIndexOf('.')
        if (lastDotIndex > 0) {
          packageName = fullClassName.substring(0, lastDotIndex)
          className = fullClassName.substring(lastDotIndex + 1)
        }
        if (packageName && packageName !== 'java.lang') {
          continue
        }

        const classScope = Scope.createSubScope(className, scope, 'class')
        classScope.sort = classScope.qid = fullClassName

        for (const method of methods) {
          if (fullClassName === baseType && method.name === className) {
            baseClsCtor = method
          }
          const targetQid = `${classScope.qid}.${method.name}`
          classScope.value[method.name] = FunctionValue({
            sid: method.name,
            qid: targetQid,
            parent: classScope,
            execute: method,
            _this: classScope,
          })
        }

        if (baseClsCtor) {
          classScope.execute = baseClsCtor
          if (fullClassName !== baseType) {
            const targetQid = `${classScope.qid}.${className}`
            classScope.value[className] = FunctionValue({
              sid: className,
              qid: targetQid,
              parent: classScope,
              execute: baseClsCtor,
              _this: classScope,
            })
          }
        }
      }
    }
  }

  /**
   * init special global builtin
   * @param scope
   */
  static initSpecialGlobalBuiltin(scope) {
    JavaInitializer.initRuntimeBuiltin(scope)
    JavaInitializer.initThreadBuiltin(scope)
  }

  /**
   * modeling for base type and subtypes
   * @param scope
   */
  static initCommonPackageBuiltin(scope) {
    const filePath = getAbsolutePath('resource/java/class-hierarchy-and-modeling.json')
    const hierarchyObj = jsonfile.readFileSync(filePath)
    if (!hierarchyObj) {
      return
    }

    for (const baseType in hierarchyObj) {
      let StructCls
      try {
        const structPath = getAbsolutePath(hierarchyObj[baseType].modelingFilePath)
        StructCls = require(structPath)
      } catch (e) {
        continue
      }
      const methods = this.findAllStaticMethodOfClass(StructCls)

      const fullClassNames = []
      fullClassNames.push(baseType)
      if (hierarchyObj[baseType].subTypeList) {
        for (const subType of hierarchyObj[baseType].subTypeList) {
          fullClassNames.push(subType)
        }
      }

      let baseClsCtor = null
      for (const fullClassName of fullClassNames) {
        let packageName
        let className = fullClassName
        const lastDotIndex = fullClassName.lastIndexOf('.')
        if (lastDotIndex > 0) {
          packageName = fullClassName.substring(0, lastDotIndex)
          className = fullClassName.substring(lastDotIndex + 1)
        }
        const packageScope = packageName ? scope.getSubPackage(packageName, true) : scope
        const classScope = Scope.createSubScope(className, packageScope, 'class')
        if (!packageScope.exports) {
          packageScope.exports = Scoped({
            sid: 'exports',
            id: 'exports',
            parent: packageScope,
          })
        }
        packageScope.exports.value[className] = classScope
        classScope.sort = classScope.qid = Scope.joinQualifiedName(packageScope.qid, className)

        for (const method of methods) {
          if (fullClassName === baseType && method.name === className) {
            baseClsCtor = method
          }
          const targetQid = `${classScope.qid}.${method.name}`
          classScope.value[method.name] = FunctionValue({
            sid: method.name,
            qid: targetQid,
            parent: classScope,
            execute: method,
            _this: classScope,
          })
        }

        if (baseClsCtor) {
          classScope.execute = baseClsCtor
          if (fullClassName !== baseType) {
            const targetQid = `${classScope.qid}.${className}`
            classScope.value[className] = FunctionValue({
              sid: className,
              qid: targetQid,
              parent: classScope,
              execute: baseClsCtor,
              _this: classScope,
            })
          }
        }
      }
    }
  }

  /**
   * init special package builtin
   * @param scope
   */
  static initSpecialPackageBuiltin(scope) {
    JavaInitializer.initExecutorsBuiltin(scope)
  }

  /**
   * 初始化runtime对象
   * @param scope
   */
  static initRuntimeBuiltin(scope) {
    const Runtime = ObjectValue({
      id: 'Runtime',
      sid: 'Runtime',
      qid: `Runtime`,
      parent: scope,
    })
    scope.setFieldValue('Runtime', Runtime)
    const getRuntime = FunctionValue({
      id: 'getRuntime',
      sid: 'getRuntime',
      qid: `Runtime.getRuntime()`,
      parent: scope,
    })
    Runtime.setFieldValue('getRuntime()', getRuntime)
    const runtimeExec = FunctionValue({
      id: 'exec',
      sid: 'exec',
      qid: `Runtime.getRuntime().exec`,
      parent: getRuntime,
    })
    getRuntime.setFieldValue('exec', runtimeExec)
    if (scope.funcSymbolTable) {
      // eslint-disable-next-line no-param-reassign
      scope.funcSymbolTable['Runtime.getRuntime()'] = getRuntime
      // eslint-disable-next-line no-param-reassign
      scope.funcSymbolTable['Runtime.getRuntime().exec'] = runtimeExec
    }
  }

  /**
   * 初始化thread对象
   * @param scope
   */
  static initThreadBuiltin(scope) {
    const Thread = ObjectValue({
      id: 'Thread',
      sid: 'Thread',
      qid: `Thread`,
      parent: scope,
    })
    scope.setFieldValue('Thread', Thread)
    const start = FunctionValue({
      // val为当前符号值，qid为当前坐标， s为scope，返回为预期的fclos
      jumpLocate: (val, qid, s) => {
        if (s && qid) {
          let current = s
          while (current) {
            if (current.sid === '<global>') {
              break
            }
            current = current.parent
          }
          const { funcSymbolTable } = current

          // 将 jumpFrom 替换为 jumpTo
          const targetQid = qid
            .replace(/<instance>/g, '')
            .split('.')
            .map((segment) => {
              return segment === 'start' ? 'run' : segment
            })
            .join('.')
          if (funcSymbolTable[targetQid]) {
            return funcSymbolTable[targetQid]
          }

          if (s.arguments instanceof Array) {
            for (const argument of s.arguments) {
              if (argument.sort?.endsWith('.Runnable') && argument.field?.run) {
                return argument.field.run
              }
            }
          }
        }
        return undefined
      },
      parent: Thread,
    })
    Thread.setFieldValue('start', start)
  }

  /**
   * 建模java.util.concurrent.Executors
   * @param scope
   */
  static initExecutorsBuiltin(scope) {
    const Executor = getValueFromPackageByQid(scope, 'java.util.concurrent.Executor')
    if (!Executor || !Executor.field) {
      return
    }

    let Executors = getValueFromPackageByQid(scope, 'java.util.concurrent.Executors')
    if (!Executors) {
      Executors = ObjectValue({
        id: 'Executors',
        sid: 'Executors',
        qid: 'Executors',
        parent: scope,
      })
      scope.setFieldValue('Executors', Executors)
    } else {
      Executors.field = {}
    }
    const returnExecutorFuncNames = [
      'newCachedThreadPool',
      'newFixedThreadPool',
      'newScheduledThreadPool',
      'newSingleThreadExecutor',
      'newSingleThreadScheduledExecutor',
      'newThreadPerTaskExecutor',
      'newVirtualThreadPerTaskExecutor',
      'newWorkStealingPool',
      'newWorkStealingPool',
      'unconfigurableExecutorService',
      'unconfigurableScheduledExecutorService',
    ]
    for (const returnExecutorFuncName of returnExecutorFuncNames) {
      const returnExecutorFunc = FunctionValue({
        id: returnExecutorFuncName,
        sid: returnExecutorFuncName,
        qid: `java.util.concurrent.Executors.${returnExecutorFuncName}`,
        parent: scope,
        execute: () => {
          return Executor
        },
      })
      Executors.setFieldValue(`${returnExecutorFuncName}`, returnExecutorFunc)
    }
  }

  /**
   * Reset / reinit global variables.
   * Particularly, reset the the line trace
   * @param node
   * @param res
   * @param scope
   */
  static resetInitVariables(scope) {
    for (const field of Object.keys(scope.value)) {
      const v = scope.value[field]
      if (v.trace) delete v.trace
    }
  }

  /**
   * find all static method of class
   * @param structCls
   */
  static findAllStaticMethodOfClass(structCls) {
    const methods = []

    while (structCls?.prototype?.constructor) {
      Object.getOwnPropertyNames(structCls).forEach((prop) => {
        if (_.isFunction(structCls[prop])) {
          methods.push(structCls[prop])
        }
      })
      structCls = structCls.__proto__
    }

    return methods
  }
}

module.exports = JavaInitializer
