const path = require('path')
const fs = require('fs-extra')
const globby = require('fast-glob')

const _ = require('lodash')
const logger = require('../../../../util/logger')(__filename)
const FileUtil = require('../../../../util/file-util')
const { Errors } = require('../../../../util/error-code')
const JsAnalyzer = require('../common/js-analyzer')
const Initializer = require('./egg-initializer')
const Loader = require('../../../../util/loader')
const EntryPointConfig = require('../../common/current-entrypoint')
const EggCommon = require('./egg-common')

const {
  valueUtil: {
    ValueUtil: { ObjectValue },
  },
} = require('../../common')

const constValue = require('../../../../util/constant')
const { cloneWithDepth } = require('../../../../util/clone-util')
const { handleException } = require('../../common/exception-handler')
const { eggSanityCheck } = require('../../../../util/framework-util')

const load_mod_enum = {
  INST: 1, // instantiate
  CALL: 2, // call
  DEFAULT: 3, // stay same
}

/**
 *
 */
class EggAnalyzer extends (JsAnalyzer as any) {
  /**
   *
   * @param options
   */
  constructor(options: any) {
    super(options)
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

    // 1st process
    this.scanModules(dir)
    Initializer.initEgg(this.moduleManager)

    // 让this.ctx.***能找到符号值
    this.loadToApp(dir, this.state)
    logger.info(`ParseCode time: ${this.totalParseTime}ms`)
    logger.info(`ProcessModule time: ${this.totalProcessTime}ms`)
  }

  /**
   *
   */
  symbolInterpret() {
    try {
      if (_.isEmpty(this.entryPoints)) {
        logger.info('[symbolInterpret]：EntryPoints are not found')
        return true
      }
      const hasAnalysised: any[] = []
      for (const entryPoint of this.entryPoints) {
        if (entryPoint.type === constValue.ENGIN_START_FUNCALL) {
          if (
            hasAnalysised.includes(
              `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?._qid}#${entryPoint.entryPointSymVal.ast.parameters}.${entryPoint.attribute}`
            )
          ) {
            continue
          }
          hasAnalysised.push(
            `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?._qid}#${entryPoint.entryPointSymVal.ast.parameters}.${entryPoint.attribute}`
          )
          EntryPointConfig.setCurrentEntryPoint(entryPoint)
          const { entryPointSymVal, argValues, scopeVal } = entryPoint

          EggCommon.refreshCtx(scopeVal?.value?.ctx?.field)
          this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
          this.replaceCtxInFunctionParams(entryPointSymVal.ast, argValues, entryPointSymVal, scopeVal, this.state)
          try {
            logger.info(
              'EntryPoint [%s.%s] is executing ',
              entryPoint.filePath?.substring(0, entryPoint?.filePath?.lastIndexOf('.')),
              entryPoint.functionName ||
                `<anonymousFunc_${entryPoint.entryPointSymVal?.ast.loc.start.line}_$${
                  entryPoint.entryPointSymVal?.ast.loc.end.line
                }>`
            )
            this.executeCall(entryPointSymVal.ast, entryPointSymVal, argValues, this.state, scopeVal)
          } catch (e) {
            handleException(
              e,
              `[${entryPoint.entryPointSymVal?.ast?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
              `[${entryPoint.entryPointSymVal?.ast?.id?.name} symbolInterpret failed. Exception message saved in error log file`
            )
          }
          this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
        } else if (entryPoint.type === constValue.ENGIN_START_FILE_BEGIN) {
          if (hasAnalysised.includes(`fileBegin:${entryPoint.filePath}.${entryPoint.attribute}`)) {
            continue
          }
          hasAnalysised.push(`fileBegin:${entryPoint.filePath}.${entryPoint.attribute}`)
          EntryPointConfig.setCurrentEntryPoint(entryPoint)
          logger.info('EntryPoint [%s] is executing ', entryPoint.filePath)
          if (entryPoint.entryPointSymVal && entryPoint.scopeVal) {
            try {
              this.processCompileUnit(
                entryPoint.scopeVal,
                entryPoint.entryPointSymVal?.ast,
                this.initState(this.topScope)
              )
            } catch (e) {
              handleException(
                e,
                `[${entryPoint.entryPointSymVal?.ast?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`,
                `[${entryPoint.entryPointSymVal?.ast?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`
              )
            }
          } else {
            const { filePath } = entryPoint
            entryPoint.entryPointSymVal = this.fileManager[filePath]
            entryPoint.scopeVal = this.fileManager[filePath]
            try {
              this.processCompileUnit(
                entryPoint.scopeVal,
                entryPoint.entryPointSymVal?.ast,
                this.initState(this.topScope)
              )
            } catch (e) {
              handleException(
                e,
                `[${entryPoint.entryPointSymVal?.ast?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`,
                `[${entryPoint.entryPointSymVal?.ast?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`
              )
            }
          }
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
              this.processInstruction(cloneWithDepth(entryPointSymVal, 2), astNode.parameters[key].id, state)
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
    const appclass = this.moduleManager.getFieldValue('Egg.Application')
    const app = this.buildNewObject(appclass.fdef, [], appclass, state, appclass.fdef, this.topScope)
    const ctxclass = this.moduleManager.getFieldValue('Egg.Context')
    const ctx = this.buildNewObject(ctxclass.fdef, [], ctxclass, state, ctxclass.fdef, this.topScope)

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
        name: ['controller', 'controllers'],
        caseStyle: 'lower',
        loadMod: load_mod_enum.INST,
        ctxInject: true,
        modsInject: ['service'],
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
            const exports = this.moduleManager.field[fullpath]
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
            let fdef = export_value.fdef || export_value.ast
            switch (opt.loadMod) {
              case load_mod_enum.INST:
                // generator indicates fdef itself is controller method, e.g.
                if (!fdef || fdef.generator) {
                  val = export_value
                } else if (fdef.type === 'FunctionDefinition') {
                  val = this.executeCall(fdef, export_value, [app], this.initState(export_value), scope)
                  if (val && val?.vtype !== 'undefine') {
                    fdef = val.fdef || val.ast
                    if (fdef) {
                      val = this.buildNewObject(fdef, [], val, this.initState(export_value), fdef, scope)
                    }
                  } else {
                    val = export_value
                  }
                } else {
                  val = this.buildNewObject(fdef, [], export_value, this.initState(export_value), fdef, scope)
                }
                break
              case load_mod_enum.CALL:
                val = this.executeCall(fdef, export_value, [app], this.initState(export_value), scope)
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
          } else {
            scope.value[prop] =
              scope.value[prop] ||
              ObjectValue({
                readonly: false,
                sid: prop,
                qid: `${scope.sid}.${prop}`,
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
   * @param isReScan
   */
  scanModules(dir: any, isReScan: boolean = false) {
    if (!eggSanityCheck(dir)) {
      handleException(null, `egg sanity check failed, dir:${dir}`, `egg sanity check failed, dir:${dir}`)
      return false
    }

    // add config dir
    const configContents = FileUtil.loadAllFileTextGlobby(
      ['config.(default|prod).(js|ts|mjs|cjs)'],
      path.resolve(dir, 'config')
    )

    // parse & load config, attach config to top scope
    if (configContents && configContents.length > 0) {
      for (const conf of configContents) {
        const sourceFile = conf.file
        const exports = this.processModuleSrc(conf.content, sourceFile, isReScan)
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
          config_val = this.executeCall({}, config_val, [], this.initState(config_val))
        }

        Initializer.assignConfig((this as any).topScopeTem || this.topScope, config_val)
      }
    }
    // logger.debug('======================== app config ==================\n%s', JSON.stringify(Initializer.plainConfig(this.topScope.value['config'])));
    // logger.debug('==========================================================\n');

    // parse & process unit, attach unit to top scope
    const egg_app_path = path.join(dir, 'app')
    const modules = FileUtil.loadAllFileTextGlobby(
      [
        '**/*.(js|ts|mjs|cjs)',
        '!**/*.d.ts',
        '!**/*.d.js',
        '!**/*.test.(js|ts|mjs|cjs|jsx)',
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
      process.exit(1)
    }
    for (const mod of modules) {
      this.processModuleSrc(mod.content, mod.file, isReScan)
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
    if (
      res?.field?.default &&
      typeof (res as any).field?.default !== undefined &&
      res.field?.default?.vtype !== 'fclos'
    ) {
      if (res?.field?.default?.field) {
        for (const key in res.field?.default?.field) {
          res.field[key] = res.field?.default?.field[key]
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
    // TODO modeling module more precisely
    // considering two aspect:
    // 1. built-in module
    // 2. importing from third party package in node_modules
    return super.loadPredefinedModule(scope, fname, node, state)
  }
}

export = EggAnalyzer
