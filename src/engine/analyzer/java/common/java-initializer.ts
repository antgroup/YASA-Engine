const jsonfile = require('jsonfile')
const _ = require('lodash')
const path = require('path')
const QidUnifyUtil = require('../../../../util/qid-unify-util')
const {
  ValueUtil: { ObjectValue, FunctionValue, Scoped },
  getValueFromPackageByQid,
} = require('../../../util/value-util')
const lombok = require('./builtins/lombok')
const config = require('../../../../config')
const { getAbsolutePath } = require('../../../../util/file-util')
const Scope = require('../../common/scope')
const { buildNewValueInstance } = require('../../../../util/clone-util')
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
  static initGlobalScope(global: any) {
    JavaInitializer.initCommonGlobalBuiltin(global)
    JavaInitializer.initSpecialGlobalBuiltin(global)
  }

  /**
   * init package scope
   * @param scope
   */
  static initPackageScope(scope: any) {
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
  static initFileScope(node: any, file: any, packageScope: any) {
    // init for module
    // const modScope = {id:file, vtype: 'modScope', value:{}, closure:{}, decls:node, parent : this.topScope, fdef:node};
    if (!file) return
    const relativePath = file.substring(config.maindirPrefix.length)
    const filename = path.basename(relativePath, path.extname(relativePath))
    const fileClos = new Scoped('', {
      sid: filename,
      qid: packageScope.qid,
      parent: packageScope,
      decls: {},
      ast: node,
    })
    fileClos.ast.fdef = node
    fileClos._this = fileClos
    fileClos.isProcessed = false
    fileClos.scope.exports = packageScope.scope.exports

    return fileClos
  }

  /**
   * modeling for base type and subtypes in java.lang
   * @param scope
   */
  static initCommonGlobalBuiltin(scope: any) {
    const filePath = getAbsolutePath('resource/java/class-hierarchy-and-modeling.json')
    const hierarchyObj = jsonfile.readFileSync(filePath)
    if (!hierarchyObj) {
      return
    }

    for (const baseType in hierarchyObj) {
      let StructCls: any
      try {
        // const structPath = getAbsolutePath(hierarchyObj[baseType].modelingFilePath)
        const structPath = hierarchyObj[baseType].modelingFilePath
        StructCls = require(structPath)
      } catch (e) {
        continue
      }
      const methods = this.findAllStaticMethodOfClass(StructCls)

      const fullClassNames: string[] = []
      fullClassNames.push(baseType)
      if (hierarchyObj[baseType].subTypeList) {
        for (const subType of hierarchyObj[baseType].subTypeList) {
          fullClassNames.push(subType)
        }
      }

      let baseClsCtor: any = null
      for (const fullClassName of fullClassNames) {
        let packageName: string = ''
        let className = fullClassName
        const lastDotIndex = fullClassName.lastIndexOf('.')
        if (lastDotIndex > 0) {
          packageName = fullClassName.substring(0, lastDotIndex)
          className = fullClassName.substring(lastDotIndex + 1)
        }
        if (packageName && packageName !== 'java.lang') {
          continue
        }

        const classScope = Scope.createSubScope(className, scope, 'class', fullClassName)

        for (const method of methods) {
          if (fullClassName === baseType && method.name === className) {
            baseClsCtor = method
          }
          const targetQid = `${classScope.qid}.${method.name}`
          classScope.value[method.name] = new FunctionValue('', {
            sid: method.name,
            qid: targetQid,
            parent: classScope,
            runtime: { execute: method },
            _this: classScope,
          })
        }

        if (baseClsCtor) {
          if (!classScope.runtime) classScope.runtime = {}
          classScope.runtime.execute = baseClsCtor
          if (fullClassName !== baseType) {
            const targetQid = `${classScope.qid}.${className}`
            classScope.value[className] = new FunctionValue('', {
              sid: className,
              qid: targetQid,
              parent: classScope,
              runtime: { execute: baseClsCtor },
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
  static initSpecialGlobalBuiltin(scope: any) {
    JavaInitializer.initRuntimeBuiltin(scope)
    JavaInitializer.initThreadBuiltin(scope)
  }

  /**
   * modeling for base type and subtypes
   * @param scope
   */
  static initCommonPackageBuiltin(scope: any) {
    const filePath = getAbsolutePath('resource/java/class-hierarchy-and-modeling.json')
    const hierarchyObj = jsonfile.readFileSync(filePath)
    if (!hierarchyObj) {
      return
    }

    for (const baseType in hierarchyObj) {
      let StructCls: any
      try {
        // const structPath = getAbsolutePath(hierarchyObj[baseType].modelingFilePath)
        const structPath = hierarchyObj[baseType].modelingFilePath
        StructCls = require(structPath)
      } catch (e) {
        continue
      }
      const methods = this.findAllStaticMethodOfClass(StructCls)

      const fullClassNames: string[] = []
      fullClassNames.push(baseType)
      if (hierarchyObj[baseType].subTypeList) {
        for (const subType of hierarchyObj[baseType].subTypeList) {
          fullClassNames.push(subType)
        }
      }

      let baseClsCtor: any = null
      for (const fullClassName of fullClassNames) {
        let packageName: string = ''
        let className = fullClassName
        const lastDotIndex = fullClassName.lastIndexOf('.')
        if (lastDotIndex > 0) {
          packageName = fullClassName.substring(0, lastDotIndex)
          className = fullClassName.substring(lastDotIndex + 1)
        }
        const packageScope = packageName ? scope.getSubPackage(packageName, true) : scope
        let classScope
        if (packageScope.members.has(className)) {
          classScope = packageScope.members.get(className)
        }
        if (!classScope) {
          classScope = Scope.createSubScope(className, packageScope, 'class', Scope.joinQualifiedName(packageScope.qid, className))
        }
        if (!packageScope.scope.exports) {
          packageScope.scope.exports = new Scoped(packageScope.qid, {
            sid: 'exports',
            parent: packageScope,
          })
        }
        packageScope.scope.exports.value[className] = classScope

        for (const method of methods) {
          if (fullClassName === baseType && method.name === className) {
            baseClsCtor = method
          }

          if (classScope.value[method.name]) {
            const fclos = classScope.value[method.name]
            if (!fclos.runtime) fclos.runtime = {}
            fclos.runtime.execute = method
            fclos._this = classScope
          } else {
            const targetQid = `${classScope.qid}.${method.name}`
            classScope.value[method.name] = new FunctionValue('', {
              sid: method.name,
              qid: targetQid,
              parent: classScope,
              runtime: { execute: method },
              _this: classScope,
            })
          }
        }

        if (baseClsCtor) {
          if (!classScope.runtime) classScope.runtime = {}
          classScope.runtime.execute = baseClsCtor
          if (fullClassName !== baseType) {
            const targetQid = `${classScope.qid}.${className}`
            classScope.value[className] = new FunctionValue('', {
              sid: className,
              qid: targetQid,
              parent: classScope,
              runtime: { execute: baseClsCtor },
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
  static initSpecialPackageBuiltin(scope: any) {
    JavaInitializer.initExecutorsBuiltin(scope)
  }

  /**
   * 初始化runtime对象
   * @param scope
   */
  static initRuntimeBuiltin(scope: any) {
    const Runtime = new ObjectValue('', {
      sid: 'Runtime',
      qid: `Runtime`,
      parent: scope,
    })
    scope.setFieldValue('Runtime', Runtime)
    const getRuntime = new FunctionValue('', {
      sid: 'getRuntime',
      qid: `Runtime.getRuntime()`,
      parent: scope,
    })
    Runtime.setFieldValue('getRuntime()', getRuntime)
    const runtimeExec = new FunctionValue('', {
      sid: 'exec',
      qid: `Runtime.getRuntime().exec`,
      parent: getRuntime,
    })
    getRuntime.setFieldValue('exec', runtimeExec)
    if (scope.context?.funcs) {
      // eslint-disable-next-line no-param-reassign
      scope.context.funcs['Runtime.getRuntime()'] = getRuntime
      // eslint-disable-next-line no-param-reassign
      scope.context.funcs['Runtime.getRuntime().exec'] = runtimeExec
    }
  }

  /**
   * 初始化thread对象
   * @param scope
   */
  static initThreadBuiltin(scope: any) {
    const Thread = new ObjectValue('', {
      sid: 'Thread',
      qid: `Thread`,
      parent: scope,
    })
    scope.setFieldValue('Thread', Thread)
    const start = new FunctionValue('', {
      func: {
        // val为当前符号值，qid为当前坐标， s为scope，返回为预期的fclos
        jumpLocate: (val: any, qid: any, s: any) => {
          if (s && qid) {
            let current = s
            while (current) {
              if (current.sid === '<global>') {
                break
              }
              current = current.parent
            }
            const funcs = current.context?.funcs

            // 将 jumpFrom 替换为 jumpTo
            const targetQid = qid
              .replace(/<instance_[^.]*?_endtag>/g, '')
              .split('.')
              .map((segment: string) => {
                return segment === 'start' ? 'run' : segment
              })
              .join('.')
            if (funcs && funcs[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)]) {
              return funcs[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)]
            }

            if (s.arguments instanceof Array) {
              for (const argument of s.arguments) {
                const runMethod = argument.members?.get('run')
                if (argument.qid?.includes('.Runnable<') && runMethod) {
                  return runMethod
                }
              }
            }
          }
          return undefined
        },
      },
      sid: 'start',
      qid: `Thread.start`,
      parent: Thread,
    })
    Thread.setFieldValue('start', start)
  }

  /**
   * 建模java.util.concurrent.Executors
   * @param scope
   */
  static initExecutorsBuiltin(scope: any) {
    const ExecutorService = getValueFromPackageByQid(scope, 'java.util.concurrent.ExecutorService')
    if (!ExecutorService || !ExecutorService.members) {
      return
    }

    let Executors = getValueFromPackageByQid(scope, 'java.util.concurrent.Executors')
    if (!Executors) {
      const packageScope = scope.getSubPackage('java.util.concurrent', true)
      Executors = Scope.createSubScope('Executors', packageScope, 'class')
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
      if (Executors.value[returnExecutorFuncName]) {
        const fclos = Executors.value[returnExecutorFuncName]
        if (!fclos.runtime) fclos.runtime = {}
        fclos.runtime.execute = () => {
          return ExecutorService
        }
      } else {
        const returnExecutorFunc = new FunctionValue('', {
          sid: returnExecutorFuncName,
          qid: `java.util.concurrent.Executors.${returnExecutorFuncName}`,
          parent: scope,
          runtime: { execute: () => {
            return ExecutorService
          } },
        })
        Executors.setFieldValue(`${returnExecutorFuncName}`, returnExecutorFunc)
      }
    }
  }

  /**
   * Reset / reinit global variables.
   * Particularly, reset the the line trace
   * @param node
   * @param res
   * @param scope
   */
  static resetInitVariables(scope: any) {
    for (const field of Object.keys(scope.value)) {
      const v = scope.value[field]
      if (v.taint) v.taint.clearTrace()
    }
  }

  /**
   * find all static method of class
   * @param structCls
   */
  static findAllStaticMethodOfClass(structCls: any) {
    const methods: any[] = []

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

  /**
   * add default property to class
   * @param classMap
   * @param scope
   * @param analyzer
   */
  static addClassProto(classMap: Map<string, any>, scope: any, analyzer: any) {
    if (!classMap) {
      return
    }
    const protoClsVal = getValueFromPackageByQid(scope, 'java.lang.Class')
    const objectClsVal = getValueFromPackageByQid(scope, 'java.lang.Object')
    for (const classValUUid of classMap.values()) {
      const classVal = analyzer.symbolTable.get(classValUUid)
      classVal.value.class = JavaInitializer.buildClassProtoObject(protoClsVal, classVal, analyzer)
      if (!classVal.value.getClass) {
        classVal.value.getClass = objectClsVal.value.getClass
      }
    }
  }

  /**
   * build class proto object
   * @param protoVal
   * @param classVal
   * @param analyzer
   * @returns {*}
   */
  static buildClassProtoObject(protoVal: any, classVal: any, analyzer: any) {
    const qidSuffix = `_<class_${classVal.logicalQid}>`
    const obj = buildNewValueInstance(
      analyzer,
      protoVal,
      null,
      protoVal.parent,
      (x: any) => {
        return x === 'class'
      },
      (v: any) => {
        return !v
      },
      1,
      qidSuffix
    )
    obj.parent = analyzer.symbolTable.get(classVal.uuid)

    return obj
  }
}

export = JavaInitializer
