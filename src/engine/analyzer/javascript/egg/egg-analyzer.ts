import { buildNewCopiedWithTag } from '../../../../util/clone-util'

const path = require('path')
const fs = require('fs-extra')
const globby = require('fast-glob')

const _ = require('lodash')
const logger = require('../../../../util/logger')(__filename)
const FileUtil = require('../../../../util/file-util')
const JsAnalyzer = require('../common/js-analyzer')
const Initializer = require('./egg-initializer')
const Loader = require('../../../../util/loader')
const EntryPointConfig = require('../../common/entrypoint/current-entrypoint')
const { executeViaEntryPointExecutor } = require('../../common/entrypoint/entrypoint-executor') as typeof import('../../common/entrypoint/entrypoint-executor')
const EggCommon = require('./egg-common')
const { TypeScriptAliasResolver } = require('./tsconfig-alias-resolver') as typeof import('./tsconfig-alias-resolver')

const {
  valueUtil: {
    ValueUtil: { ObjectValue },
  },
} = require('../../common')

const constValue = require('../../../../util/constant')
const { handleException } = require('../../common/exception-handler')
const { ErrorCode } = require('../../../../util/error-code')
const { eggSanityCheck } = require('../../../../util/framework-util')

const load_mod_enum = {
  INST: 1, // instantiate
  CALL: 2, // call
  DEFAULT: 3, // stay same
}

type ScannedProjectModule = {
  file: string
  content: string
}

/**
 *
 */
class EggAnalyzer extends JsAnalyzer {
  // EP 隔离基线：preProcess 后快照共享 scope 树的 key 集合
  private _sharedScopeBaselineKeys: Map<any, Set<string>> | null = null
  private moduleAliasResolver: import('./tsconfig-alias-resolver').TypeScriptAliasResolver | undefined
  private scannedProjectModules = new Map<string, string>()

  /**
   *
   * @param options
   */
  constructor(options: any) {
    super(options)
    this.enableNestedSourceLineIsolation = true
  }

  /**
   *
   * @param dir
   */
  preProcess(dir: any) {
    // init global scope
    Initializer.initGlobalScope(this.topScope)
    // prepare state
    this.state = this.initState(this.topScope)

    // leoric ORM 适配：在 scanModules 之前初始化，使 import 能找到预置的 stub
    Initializer.initLeoric(this.topScope.context.modules)

    // 1st process
    this.scanModules(dir)

    Initializer.initEgg(this.topScope.context.modules)

    // 让this.ctx.***能找到符号值
    this.loadToApp(dir, this.state)
    // 快照共享 scope 树基线 key，用于 EP 隔离
    this._sharedScopeBaselineKeys = this._captureSharedScopeKeys()
  }

  /**
   * 加载缓存后的初始化阶段，会创建一些全局builtin
   */
  initAfterUsingCache() {
    Initializer.introduceGlobalBuiltin(this.topScope)
    // prepare state
    this.state = this.initState(this.topScope)
  }

  /**
   *
   */
  async symbolInterpret(): Promise<boolean> {
    try {
      if (_.isEmpty(this.entryPoints)) {
        logger.info('[symbolInterpret]：EntryPoints are not found')
        return true
      }
      const hasAnalysised = new Set<string>()
      let epIdx = 0
      for (const entryPoint of this.entryPoints) {
        epIdx++
        const metricStartTime = Date.now()
        const findingsBefore = this.countFindings()
        let skipped = false
        let skipReason: string | undefined
        try {
          if (entryPoint.type === constValue.ENGIN_START_FUNCALL) {
            this.symbolTable.clear()
            const entryPointMark = this.markEntryPointForAnalysis(entryPoint, hasAnalysised)
            if (entryPointMark.skipped) {
              skipped = true
              skipReason = entryPointMark.skipReason
              continue
            }
            EntryPointConfig.setCurrentEntryPoint(entryPoint)
            const { entryPointSymVal, argValues, scopeVal } = entryPoint

            executeViaEntryPointExecutor(
              {
                analyzer: this,
                entryPoint,
                metricStartTime,
                findingsBefore,
                executionState: this.state,
                overloadCount: 1,
                epIndex: epIdx,
                epTotal: this.entryPoints.length,
              },
              {
                language: 'egg',
                classify: () => 'function',
                execute: () => {
                  // refreshCtx 依赖 field proxy 的 delete trap，需配合 refreshCtx 一起迁移
                  EggCommon.refreshCtx(scopeVal?.value?.ctx?.value)
                  this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
                  this.replaceCtxInFunctionParams(entryPointSymVal.ast.node, argValues, entryPointSymVal, scopeVal, this.state)
                  try {
                    this.executeCall(entryPointSymVal.ast.node, entryPointSymVal, this.state, scopeVal, {
                      callArgs: this.buildCallArgs(entryPointSymVal.ast.node, argValues, entryPointSymVal),
                    })
                  } catch (e) {
                    handleException(
                      e,
                      `[${entryPoint.entryPointSymVal?.ast?.node?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
                      `[${entryPoint.entryPointSymVal?.ast?.node?.id?.name} symbolInterpret failed. Exception message saved in error log file`
                    )
                  }
                  this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
                },
                dispose: () => {
                  // EP 隔离：清除本 EP 写入共享 scope 树（ctx.service/controller 等）的新增 key
                  this._restoreSharedScopeKeys()
                },
              },
              this.checkerManager?.resultManagerProxy,
            )
          } else if (entryPoint.type === constValue.ENGIN_START_FILE_BEGIN) {
            const entryPointMark = this.markEntryPointForAnalysis(entryPoint, hasAnalysised)
            if (entryPointMark.skipped) {
              skipped = true
              skipReason = entryPointMark.skipReason
              continue
            }
            EntryPointConfig.setCurrentEntryPoint(entryPoint)
            if (!entryPoint.entryPointSymVal || !entryPoint.scopeVal) {
              const { filePath } = entryPoint
              const fileRecord = this.fileManager[filePath]
              if (!fileRecord) {
                skipped = true
                skipReason = 'missing'
                continue
              }
              entryPoint.entryPointSymVal = this.symbolTable.get(fileRecord.uuid)
              entryPoint.scopeVal = this.symbolTable.get(fileRecord.uuid)
            }
            if (entryPoint.entryPointSymVal && entryPoint.scopeVal) {
              const fileState = this.initState(this.topScope)
              try {
                executeViaEntryPointExecutor(
                  {
                    analyzer: this,
                    entryPoint,
                    metricStartTime,
                    findingsBefore,
                    executionState: fileState,
                    overloadCount: 1,
                    epIndex: epIdx,
                    epTotal: this.entryPoints.length,
                  },
                  {
                    language: 'egg',
                    classify: () => 'file',
                    before: () => {
                      this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
                    },
                    execute: () => {
                      this.processCompileUnit(entryPoint.scopeVal, entryPoint.entryPointSymVal?.ast?.node, fileState)
                    },
                    after: () => {
                      this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
                    },
                  },
                  this.checkerManager?.resultManagerProxy,
                )
              } catch (e) {
                handleException(
                  e,
                  `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`,
                  `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`
                )
              }
            }
          } else {
            skipped = true
            skipReason = 'unsupported'
          }
        } finally {
          this.recordEntryPointLoopMetric(entryPoint, metricStartTime, findingsBefore, skipped, skipReason, 1)
        }
      }
    } catch (e) {
      handleException(
        e,
        `Error occurred in EggAnalyzer.symbolInterpret`,
        `Error occurred in EggAnalyzer.symbolInterpret`
      )
    }
    return true
  }

  /**
   *
   * @param astNode
   * @param argValues
   * @param entryPointSymVal
   * @param valExport
   * @param state
   */
  replaceCtxInFunctionParams(astNode: any, argValues: any[], entryPointSymVal: any, valExport: any, state: any) {
    if (astNode?.type === 'FunctionDefinition') {
      if (Array.isArray(astNode.parameters) && astNode.parameters?.length > 0) {
        for (const key in astNode.parameters) {
          if (astNode.parameters[key].id?.name === 'ctx') {
            // 进一步判断有没有decorator @Context。暂时不判断
            argValues.push(valExport.value.ctx)
          } else {
            argValues.push(
              this.processInstruction(
                buildNewCopiedWithTag(this, entryPointSymVal, 'tmp'),
                astNode.parameters[key].id,
                state
              )
            )
          }
        }
      }
    }
  }

  /**
   * load modules(controller, service, middleware, etc.), inject to Application/Ctx
   * @param dir
   * @param state
   */
  loadToApp(dir: any, state: any) {
    const appclass = this.topScope.context.modules.getFieldValue('Egg.Application')
    const app = this.buildNewObject(appclass.ast.fdef, appclass, state, appclass.ast.fdef, this.topScope)
    const ctxclass = this.topScope.context.modules.getFieldValue('Egg.Context')
    const ctx = this.buildNewObject(ctxclass.ast.fdef, ctxclass, state, ctxclass.ast.fdef, this.topScope)

    this.topScope.setFieldValue('ctx', ctx)
    this.topScope.setFieldValue('app', app)

    const dir_opts = [
      {
        name: ['service', 'services'],
        caseStyle: 'lower',
        loadMod: load_mod_enum.INST,
        ctxInject: true,
        modsInject: ['service'],
      },
      {
        name: 'middleware',
        caseStyle: 'lower',
        loadMod: load_mod_enum.DEFAULT,
        ctxInject: false,
        modsInject: [],
      },
      {
        name: 'proxy',
        caseStyle: 'lower',
        loadMod: load_mod_enum.INST,
        ctxInject: true,
        modsInject: ['service'],
      },
      {
        name: ['controller', 'controllers'],
        caseStyle: 'lower',
        loadMod: load_mod_enum.INST,
        ctxInject: true,
        modsInject: ['service', 'proxy'],
      },
      {
        name: 'rpc',
        caseStyle: 'lower',
        loadMod: load_mod_enum.INST,
        ctxInject: true,
        modsInject: ['service'],
      },
      {
        name: 'modules',
        caseStyle: 'lower',
        loadMod: load_mod_enum.INST,
        ctxInject: true,
        modsInject: ['service'],
      },
      {
        name: 'common',
        caseStyle: 'lower',
        loadMod: load_mod_enum.INST,
        ctxInject: true,
        modsInject: ['service'],
      },
    ]
    const files = ['**/*.(js|ts|mjs|cjs)', '!**/*.d.ts', '!**/*.d.js']

    for (const opt of dir_opts) {
      let app_dir
      let filepaths: string[] = []
      let module_name
      if (Array.isArray(opt.name)) {
        for (const i in opt.name) {
          module_name = opt.name[i]
          app_dir = path.join(dir, 'app', module_name)
          filepaths = globby.sync(files, { cwd: app_dir })
          if (filepaths.length !== 0) break
        }
      } else {
        module_name = opt.name
        app_dir = path.join(dir, 'app', module_name)
        filepaths = globby.sync(files, { cwd: app_dir })
      }

      for (const filepath of filepaths) {
        const fullpath = path.join(app_dir, filepath)
        if (!fs.statSync(fullpath).isFile()) continue
        // get properties
        // app/service/foo/bar.js => [ 'foo', 'bar' ]
        const properties = Loader.getFilePathProperties(filepath, opt)
        properties.unshift(module_name)

        let scope = app
        for (let i = 0; i < properties.length; i++) {
          const prop = properties[i]
          if (i === properties.length - 1) {
            const exports = this.topScope.context.modules.members.get(fullpath)
            if (!exports) {
              handleException(null, '', `${fullpath} module is not found`)
              continue
            }
            // const export_value = exports.value.default || exports;
            const export_value = exports
            if (!export_value) {
              handleException(null, '', `loadToApp ${properties.join('.')} : process module failed`)
              continue
            }
            let val
            let fdef = export_value.ast.fdef || export_value.ast.node
            switch (opt.loadMod) {
              case load_mod_enum.INST:
                // generator indicates fdef itself is controller method, e.g.
                if (!fdef || fdef.generator) {
                  val = export_value
                } else if (fdef.type === 'FunctionDefinition') {
                  val = this.executeCall(fdef, export_value, this.initState(export_value), scope, { callArgs: this.buildCallArgs(fdef, [app], export_value) })
                  if (val && val?.vtype !== 'undefine') {
                    fdef = val.ast.fdef || val.ast.node
                    if (fdef) {
                      val = this.buildNewObject(fdef, val, this.initState(export_value), fdef, scope)
                    }
                  } else {
                    val = export_value
                  }
                } else {
                  val = this.buildNewObject(fdef, export_value, this.initState(export_value), fdef, scope)
                }
                break
              case load_mod_enum.CALL:
                val = this.executeCall(fdef, export_value, this.initState(export_value), scope, { callArgs: this.buildCallArgs(fdef, [app], export_value) })
                break
              default:
                val = export_value
            }
            if (!val) continue
            scope.value[prop] = val
            if (!val.parent) {
              val.parent = scope
            }
            if (opt.ctxInject && val.value) {
              val.value.ctx = ctx
            }
            if (val.value) {
              for (const mod of opt.modsInject) {
                val.value[mod] = app.value[mod]
              }
            }
            // egg 依赖注入字段同步到 class 定义作用域：dumpAllCG 不走 entrypoint，executeCall
            // 类方法时 this 绑定到 class 定义而非实例，class 定义上缺少 ctx/service 等注入字段，
            // 导致 this.service.X.method() 解析退化为属性访问链拼接的假节点。把注入字段同步到
            // class 定义作用域后，this.service / this.ctx 在 dumpAllCG 下可解析到真实 Service 实例。
            const defVal = exports?.members?.get?.('default')
            if (defVal && defVal.vtype === 'class' && defVal.value) {
              if (opt.ctxInject) {
                defVal.value.ctx = ctx
              }
              for (const mod of opt.modsInject) {
                defVal.value[mod] = app.value[mod]
              }
            }
          } else {
            scope.value[prop] =
              scope.value[prop] ||
              new ObjectValue(scope.qid, {
                runtime: { readonly: false },
                sid: prop,
                parent: scope,
              })
            scope = scope.value[prop]
          }
        }
      }

      if (opt.ctxInject && module_name) {
        ctx.value[module_name] = app.value[module_name]
      }
    }
  }

  /**
   *
   * @param dir
   */
  scanModules(dir: any) {
    if (!eggSanityCheck(dir)) {
      handleException(null, `egg sanity check failed, dir:${dir}`, `egg sanity check failed, dir:${dir}`)
      return false
    }

    this.moduleAliasResolver = TypeScriptAliasResolver.load(dir)

    // add config dir
    const configContents = FileUtil.loadAllFileTextGlobby(
      ['config.(default|prod).(js|ts|mjs|cjs)'],
      path.resolve(dir, 'config')
    )

    // parse & load config, attach config to top scope
    if (configContents && configContents.length > 0) {
      for (const conf of configContents) {
        const sourceFile = conf.file
        const exports = this.processModuleSrc(conf.content, sourceFile)
        // if (!exports || exports.id !== 'module.exports') {
        if (!exports) {
          handleException(null, '', `process config module failed, config:${sourceFile}`)
          continue
        }
        let config_val = exports
        if (exports.vtype !== 'fclos') {
          config_val = exports.value.default || exports.value
        }
        if (!config_val) {
          handleException(null, '', `process config module failed, config:${sourceFile}`)
          continue
        }
        if (config_val.vtype === 'fclos') {
          config_val = this.executeCall({}, config_val, this.initState(config_val), undefined)
        }

        Initializer.assignConfig((this as any).topScopeTem || this.topScope, config_val)
      }
    }
    // logger.debug('======================== app config ==================\n%s', JSON.stringify(Initializer.plainConfig(this.topScope.value['config'])));
    // logger.debug('==========================================================\n');

    // parse & process unit, attach unit to top scope
    // tegg 新目录结构用 src/，传统 egg 用 app/
    let egg_app_path = path.join(dir, 'app')
    if (!fs.existsSync(egg_app_path) && fs.existsSync(path.join(dir, 'src'))) {
      egg_app_path = path.join(dir, 'src')
    }
    const modules: ScannedProjectModule[] = FileUtil.loadAllFileTextGlobby(
      [
        '**/*.(js|ts|mjs|cjs)',
        '!**/*.d.ts',
        '!**/*.d.js',
        '!**/*.test.(js|ts|mjs|cjs|jsx|tsx)',
        '!**/node_modules',
        '!web',
        '!**/public/**',
        '!**/assets/**',
        '!**/views/**',
        '!**/view/**',
        '!**/viewer/**',
        '!**/dist/**',
      ],
      egg_app_path
    )
    if (modules.length === 0) {
      handleException(
        null,
        'find no target compileUnit of the project : no js/ts file found in source path',
        'find no target compileUnit of the project : no js/ts file found in source path'
      )
      process.exitCode = ErrorCode.no_valid_source_file
      return false
    }
    this.scannedProjectModules = new Map(modules.map((mod) => [path.resolve(mod.file), mod.content]))
    for (const mod of modules) {
      this.processModuleSrc(mod.content, mod.file)
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processVariableDeclaration(scope: any, node: any, state: any) {
    // @inject适配
    if (node.varType?.type === 'ScopedType' && node?._meta?.decorators) {
      const decorators = node?._meta?.decorators
      let isInject = false
      for (const decorator of decorators) {
        if (decorator?.type === 'CallExpression') {
          if (decorator.callee?.name === 'inject' || decorator.callee?.name === 'Inject') {
            isInject = true
            break
          }
        }
      }
      if (isInject) {
        if (node.varType.id?.type === 'Identifier') {
          const className = node.varType.id?.name
          if (className && className !== '') {
            node.init = {
              type: 'NewExpression',
              callee: node.varType.id,
              arguments: [],
              _meta: node._meta,
              loc: node.loc,
              parent: node.parent,
            }
          }
        }
      }
    }
    return super.processVariableDeclaration(scope, node, state)
  }

  /**
   *
   * @param ast
   * @param filename
   * @param modClos
   */
  processModuleDirect(ast: any, filename: any, modClos: any) {
    const res = super.processModuleDirect(ast, filename, modClos)
    // merge default into parent
    const defaultVal = res?.members?.get('default')
    if (
      defaultVal &&
      typeof defaultVal !== 'undefined' &&
      defaultVal?.vtype !== 'fclos'
    ) {
      if (defaultVal?.members) {
        for (const key of defaultVal.members.keys()) {
          const val = defaultVal.members.get(key)
          if (val) res.members.set(key, val)
        }
      }
    }
    return res
  }

  // load predefined module
  /**
   *
   * @param scope
   * @param fname
   * @param node
   * @param state
   */
  loadPredefinedModule(scope: any, fname: any, node: any, state: any) {
    const modulePath = this.moduleAliasResolver?.resolveScannedModulePath(fname, this.scannedProjectModules)
    if (modulePath) {
      const module = this.topScope.context.modules.members.get(modulePath)
      if (module && typeof module === 'object') return module
      const source = this.scannedProjectModules.get(modulePath)
      if (source !== undefined) return this.processModuleSrc(source, modulePath)
    }
    return super.loadPredefinedModule(scope, fname, node, state)
  }

  private _captureSharedScopeKeys(): Map<any, Set<string>> {
    const baseline = new Map<any, Set<string>>()
    const app = (this.topScope as any).value?.app
    if (!app?._members) return baseline
    for (const modName of ['service', 'controller', 'rpc', 'modules', 'common']) {
      const modScope = app._members.get(modName)
      if (!modScope?._members) continue
      baseline.set(modScope._members, new Set(modScope._members.keys()))
      for (const key of modScope._members.keys()) {
        const instance = modScope._members.get(key)
        if (instance?._members) {
          baseline.set(instance._members, new Set(instance._members.keys()))
        }
      }
    }
    return baseline
  }

  private _restoreSharedScopeKeys(): void {
    const baseline = this._sharedScopeBaselineKeys
    if (!baseline) return
    for (const [members, baseKeys] of baseline) {
      for (const key of members.keys()) {
        if (!baseKeys.has(key)) {
          members.delete(key)
        }
      }
    }
  }
}

export = EggAnalyzer
