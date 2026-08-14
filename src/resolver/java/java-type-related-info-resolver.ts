import TypeRelatedInfoResolver from '../common/type-related-info-resolver'
import type { ClassHierarchy } from '../common/value/class-hierarchy'
import type { TypeRelatedInfoResult } from '../common/value/type-related-info-result'
import type { Invocation } from '../common/value/invocation'

const QidUnifyUtil = require('../../util/qid-unify-util')
const { prettyPrint } = require('../../util/ast-util')
const { getValueFromPackageByQid } = require('../../engine/util/value-util')

/**
 * JavaTypeRelatedInfoResolver
 *
 * Java 语义定制的类型解析器：
 * - resolve / findClassHierarchy：原有能力
 * - resolveIdentifierShadowFieldHook：JLS value-position identifier shadow 修复
 *   （field 与 method 同名时，identifier 在 value-position 必须解析为 field，而不是
 *    取 method 的 returnType）
 * - narrowCalleeTypeByReceiver：callsite receiver 静态类型收敛
 *   （field-call / local-call / param-call 形态下，用 receiver 的 declared 具体类型
 *    替代原 invocation.calleeType 作为 findPolymorphismInvocation 的根，避免全子树扇出）
 */
type JavaAnalyzerLike = {
  classMap?: Map<string, unknown>
  topScope?: { context?: { packages?: unknown } }
}

type JavaScopeLike = {
  parent?: JavaScopeLike
  fileScope?: { ast?: { node?: { body?: unknown[] } } }
  declarationMap?: Map<string, { type?: string }>
  scope?: { declarationMap?: Map<string, { type?: string }> }
}

type JavaMemberAccessLike = {
  type?: string
  object?: { type?: string; name?: string }
  property?: { name?: string }
}

export default class JavaTypeRelatedInfoResolver extends TypeRelatedInfoResolver {
  /**
   *
   * @param analyzer
   */
  override resolve(analyzer: any) {
    super.resolve(analyzer)

    for (const classVal of analyzer.classMap.values()) {
      if (!classVal.super || !classVal.members?.size) {
        continue
      }
      for (const [key, element] of classVal.members.entries() as any[]) {
        if (key === 'super' || !element || element.vtype !== 'fclos' || !element.func?.inherited) {
          continue
        }
        const baseVal = element._base?.members?.get(key)
        if (baseVal?.vtype === 'fclos') {
          element.scope.declarationMap = baseVal.scope.declarationMap
          element.invocationMap = baseVal.invocationMap
        }
      }
    }
  }

  /**
   * find class hierarchy
   * @param analyzer
   * @param state
   * @returns {Map<string, ClassHierarchy>}
   */
  override findClassHierarchy(analyzer: any, state: any): Map<string, ClassHierarchy> {
    const resultMap: Map<string, ClassHierarchy> = new Map()
    if (!analyzer.classMap) {
      return resultMap
    }

    // 短名 → 全限定名索引：用于 supers 短名无法被 getMemberValueNoCreate 命中时的回退
    const shortNameToFqn: Map<string, string[]> = new Map()
    if (analyzer.classMap && analyzer.symbolTable) {
      for (const uuid of analyzer.classMap.values()) {
        const cv = analyzer.symbolTable.get(uuid)
        if (!cv) continue
        const fqn: string = cv.logicalQid
        const dot = fqn.lastIndexOf('.')
        const short = dot >= 0 ? fqn.substring(dot + 1) : fqn
        if (!shortNameToFqn.has(short)) shortNameToFqn.set(short, [])
        shortNameToFqn.get(short)!.push(fqn)
      }
    }

    for (const classValUuid of analyzer.classMap.values()) {
      const classVal = analyzer.symbolTable.get(classValUuid)
      if (!classVal.ast.node) {
        continue
      }

      let classHierarchy = resultMap.get(classVal.logicalQid)
      if (!classHierarchy) {
        classHierarchy = {
          typeDeclaration: this.inferTypeDeclaration(classVal),
          type: classVal.logicalQid,
          value: classVal,
          extends: [],
          extendedBy: [],
          implements: [],
          implementedBy: [],
        }
        resultMap.set(classVal.logicalQid, classHierarchy)
      }

      if (!Array.isArray(classVal.ast?.node?.supers) || classVal.ast.node.supers.length === 0) {
        continue
      }

      for (const superAst of classVal.ast.node.supers) {
        let superClsVal = this.getMemberValueNoCreate(classVal, superAst, state)
        let superClsName = superClsVal ? superClsVal.logicalQid : superAst.name
        // 外部接口解析失败时按短名唯一匹配回退到 FQN，保留正确的 implements 链路
        if (!superClsVal && superAst.name && shortNameToFqn.has(superAst.name)) {
          const candidates = shortNameToFqn.get(superAst.name)!
          if (candidates.length === 1) {
            const fqn = candidates[0]
            const uuid = analyzer.classMap.get(fqn)
            if (uuid) {
              superClsVal = analyzer.symbolTable.get(uuid)
              superClsName = fqn
            }
          }
        }
        let superClassHierarchy = resultMap.get(superClsName)
        if (!superClassHierarchy) {
          superClassHierarchy = {
            typeDeclaration: this.inferTypeDeclaration(superClsVal),
            type: superClsName,
            value: superClsVal,
            extends: [],
            extendedBy: [],
            implements: [],
            implementedBy: [],
          }
          resultMap.set(superClsName, superClassHierarchy)
        }

        if (classHierarchy.typeDeclaration === 'class' && superClassHierarchy.typeDeclaration === 'interface') {
          classHierarchy.implements.push(superClassHierarchy)
          superClassHierarchy.implementedBy.push(classHierarchy)
        } else {
          classHierarchy.extends.push(superClassHierarchy)
          superClassHierarchy.extendedBy.push(classHierarchy)
        }
      }
    }

    for (const classValUuid of analyzer.classMap.values()) {
      const classVal = analyzer.symbolTable.get(classValUuid)
      if (!classVal) {
        continue
      }
      const fullClassName = classVal.logicalQid
      if (!analyzer.extraClassHierarchyByNameMap?.has(fullClassName)) {
        continue
      }
      let classHierarchy = resultMap.get(classVal.logicalQid)
      if (!classHierarchy) {
        classHierarchy = {
          typeDeclaration: 'class',
          type: classVal.logicalQid,
          value: classVal,
          extends: [],
          extendedBy: [],
          implements: [],
          implementedBy: [],
        }
        resultMap.set(fullClassName, classHierarchy)
      }
      const subTypes = this.findSubTypes(classHierarchy)
      for (const superClsName of analyzer.extraClassHierarchyByNameMap.get(fullClassName)) {
        if (subTypes.includes(superClsName)) {
          continue
        }
        const superClsVal = getValueFromPackageByQid(analyzer?.topScope?.context?.packages, superClsName)
        if (superClsVal?.vtype === 'class') {
          let superClassHierarchy = resultMap.get(superClsName)
          if (!superClassHierarchy) {
            superClassHierarchy = {
              typeDeclaration: 'class',
              type: superClsName,
              value: superClsVal,
              extends: [],
              extendedBy: [],
              implements: [],
              implementedBy: [],
            }
            resultMap.set(superClsName, superClassHierarchy)
          }

          if (classHierarchy.typeDeclaration === 'class' && superClassHierarchy.typeDeclaration === 'interface') {
            classHierarchy.implements.push(superClassHierarchy)
            superClassHierarchy.implementedBy.push(classHierarchy)
          } else {
            classHierarchy.extends.push(superClassHierarchy)
            superClassHierarchy.extendedBy.push(classHierarchy)
          }
        }
      }
    }

    return resultMap
  }

  /**
   * JLS value-position identifier shadow 修复
   *
   * Java 语义：identifier 单独出现在 expression 位置（非 CallExpression.callee 直接子节点）
   * 必须解析为 value（field / local / param），即使存在同名 method。
   * 当前 common `resolveIdentifier` fclos 优先取 returnType 违反该语义——例如同时存在
   *   private FooClient fooClient;                              // field, 类型 FooClient
   *   private BarResult fooClient(String, String) {...}         // method, 返回 BarResult
   * 时，`fooClient.execute(param)` 中的 receiver identifier 应解析为 field 类型（FooClient）
   * 而非 method returnType（BarResult）。
   *
   * 未命中 shadow / 处于 invocable 上下文 → return undefined → 走 common 原分支。
   *
   * @param analyzer
   * @param scope
   * @param node identifier AST node
   * @param state
   * @param val fclos value（common 已解析出来）
   * @param defScope fclos 所在 class scope
   * @param defScopeType class qid
   */
  override resolveIdentifierShadowFieldHook(
    analyzer: any,
    scope: any,
    node: any,
    state: any,
    val: any,
    defScope: any,
    defScopeType: string
  ): TypeRelatedInfoResult[] | undefined {
    // invocable 上下文：当前 identifier 是 CallExpression.callee 直接位置 → 不收敛，走 fclos returnType
    // state.callExpressionCallee 由 common resolveCallExpression 注入
    if (state?.callExpressionCallee === node) {
      return undefined
    }

    // defScope 必须是 class（value-position 的 shadow 语义只在类成员层面成立）
    if (!defScope || defScope.vtype !== 'class') {
      return undefined
    }

    // 扫 enclosing class 的 AST body 找同名 field（VariableDeclaration）
    // 不依赖 classVal.members（Map 键唯一，field+method 同名时其中之一可能被覆盖）
    const shadowField = this.scanFieldDeclarationByName(defScope, node.name)
    if (!shadowField) {
      return undefined
    }

    const fieldType = this.extractFieldStaticType(shadowField)
    if (!fieldType) {
      return undefined
    }

    const resultArray: TypeRelatedInfoResult[] = []
    resultArray.push(
      this.assembleTypeResult(
        node,
        0,
        node.name,
        fieldType,
        val,
        shadowField,
        defScope,
        defScopeType
      )
    )
    return resultArray
  }

  /**
   * 扫 class scope 对应的 AST body（cdef.body / node.body），找同名 VariableDeclaration
   * 返回 VariableDeclaration AST node 或 undefined
   *
   * @param classScope vtype='class' 的 scope
   * @param name identifier 名
   */
  scanFieldDeclarationByName(classScope: any, name: string): any | undefined {
    const cdef = classScope?.ast?.cdef ?? classScope?.ast?.node
    const body = cdef?.body
    if (!body) return undefined

    // body 可能是 BlockStatement，也可能是数组
    const statements: any[] = Array.isArray(body) ? body : (Array.isArray(body.body) ? body.body : [])
    for (const stmt of statements) {
      if (!stmt) continue
      if (stmt.type === 'VariableDeclaration' && stmt.id?.type === 'Identifier' && stmt.id.name === name) {
        return stmt
      }
    }
    return undefined
  }

  /**
   * 从 VariableDeclaration AST 提取静态类型字符串
   *
   * @param varDecl VariableDeclaration AST node
   */
  extractFieldStaticType(varDecl: any): string | undefined {
    const varType = varDecl?.varType
    if (!varType) return undefined
    // varType 一般是 Identifier / MemberAccess / GenericType / 其他 type AST
    const printed = prettyPrint(varType)
    if (!printed || typeof printed !== 'string') return undefined
    return QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(printed)
  }

  override resolveMemberAccess(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const results = super.resolveMemberAccess(analyzer, scope, node, state)
    const importedReceiverType = this.resolveImportedReceiverTypeForMemberAccess(analyzer, scope, node)
    if (!importedReceiverType) return results

    for (const result of results) {
      if (result.valueDefScopeType === '') {
        result.valueDefScopeType = importedReceiverType
      }
    }
    return results
  }

  private resolveImportedReceiverTypeForMemberAccess(
    analyzer: JavaAnalyzerLike,
    scope: JavaScopeLike,
    node: JavaMemberAccessLike
  ): string | undefined {
    if (node?.type !== 'MemberAccess' || node.object?.type !== 'Identifier') return undefined
    const receiverName = node.object.name
    if (!receiverName || this.lookupDeclaredType(scope, receiverName)) return undefined

    const astBody = this.findFileScopeAstBody(scope)
    if (!astBody) return undefined
    for (const statement of astBody) {
      const importedClass = this.getImportedClassName(statement, receiverName)
      if (importedClass && this.classExists(analyzer, importedClass)) {
        return importedClass
      }
    }
    return undefined
  }

  // fileScope 只挂在外层 class 作用域且通过 ScopeCtx 持有；嵌套块/克隆 scope 需沿 parent 链回溯，
  // 并兼顾旧路径 cur.fileScope 与新路径 cur.scope?.fileScope。
  private findFileScopeAstBody(scope: JavaScopeLike): unknown[] | undefined {
    let cur: any = scope
    let guard = 32
    while (cur && guard-- > 0) {
      const body = (cur.fileScope?.ast?.node?.body) ?? (cur.scope?.fileScope?.ast?.node?.body)
      if (Array.isArray(body)) return body
      cur = cur.parent
    }
    return undefined
  }

  private lookupDeclaredType(scope: JavaScopeLike, name: string): string | undefined {
    let current: JavaScopeLike | undefined = scope
    while (current) {
      const decl = current.declarationMap?.get(name) ?? current.scope?.declarationMap?.get(name)
      if (decl?.type) return decl.type
      current = current.parent
    }
    return undefined
  }

  private classExists(analyzer: JavaAnalyzerLike, className: string): boolean {
    if (analyzer.classMap?.has(className)) return true
    return Boolean(this.getPackageValueByQid(analyzer.topScope?.context?.packages, className))
  }

  private getPackageValueByQid(packages: unknown, qid: string): unknown {
    const root = packages as { members?: Map<string, unknown>; getMemberValue?: (name: string) => unknown } | undefined
    let current = root
    for (const segment of qid.split('.').filter(Boolean)) {
      current = (current?.members?.get(segment) ?? current?.getMemberValue?.(segment)) as typeof current
      if (!current) return undefined
    }
    return current
  }

  private getImportedClassName(statement: unknown, name: string): string | undefined {
    const node = statement as {
      type?: string
      id?: { name?: string }
      varType?: { id?: { name?: string } }
      init?: { type?: string; from?: { value?: unknown }; imported?: { name?: string } }
    }
    if (node.type !== 'VariableDeclaration' || node.init?.type !== 'ImportExpression') return undefined
    if (node.id?.name !== name && node.init.imported?.name !== name) return undefined
    const importType = node.varType?.id?.name
    const importFrom = typeof node.init.from?.value === 'string' ? node.init.from.value : undefined
    const candidate = importType && importType.includes('.') ? importType : importFrom ? `${importFrom}.${name}` : undefined
    return candidate ? QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(candidate) : undefined
  }

  /**
   * callsite receiver 静态类型收敛（field-call / local-call / param-call）
   *
   * 触发条件：
   *   - CallExpression.callee 是 MemberAccess
   *   - MemberAccess.object 不是 ThisExpression / SuperExpression
   *   - object 可静态解析为**具体 class**（非 interface、非 abstract base、非 Object）
   *
   * 返回收敛后的 calleeType（作为 findPolymorphismInvocation 的新根）；undefined = fallback 到原全子树。
   *
   * Fallback 规则：
   *   - receiver 静态类型不可解析     → undefined
   *   - 静态类型是 interface         → undefined（接口多态合理 fan-out，不收敛）
   *   - 静态类型是 abstract base 自身 → undefined（让 common 走 may-dispatch 全展开，
   *     由 caller-aware 后处理在 callgraph 层做更精确的收敛）
   *
   * 非 Java 语言走 default hook（return undefined），保持原行为。
   *
   * @param analyzer
   * @param scope
   * @param node CallExpression AST node
   * @param state
   * @param invocation 已构建的 invocation（invocation.calleeType = 原静态 callee type）
   */
  override narrowCalleeTypeByReceiver(
    analyzer: any,
    scope: any,
    node: any,
    state: any,
    invocation: Invocation
  ): string | undefined {
    const callee = node?.callee
    if (!callee) return undefined

    // 只处理 MemberAccess callee（field.exec() / local.exec() / param.exec()）
    // ThisExpression / SuperExpression 不走本 case（Case II self-in-abstract 本轮暂缓；super 走 L439 invokeSuper 分支）
    if (callee.type !== 'MemberAccess') return undefined
    const obj = callee.object
    if (!obj || obj.type === 'ThisExpression' || obj.type === 'SuperExpression') return undefined

    // 解析 receiver 静态类型
    const objTypeResultArray = this.resolveInstruction(analyzer, scope, obj, state)
    if (!Array.isArray(objTypeResultArray) || objTypeResultArray.length !== 1) return undefined
    const objType = objTypeResultArray[0]?.type
    if (!objType || objType === '') return undefined

    // 静态类型与 invocation.calleeType 相同 → 无收敛收益
    if (objType === invocation.calleeType) return undefined

    const h = this.classHierarchyMap.get(objType)
    if (!h) return undefined

    // F3：interface 静态类型保留原全子树（接口多态合理 fan-out）
    if (h.typeDeclaration === 'interface') return undefined

    // abstract base 自身保留原全子树（典型如 abstract `Foo` + 多个 `FooImpl1/2/3` 子类，
    // receiver 静态类型就是 abstract Foo 时无法收敛，让全 may-dispatch 展开）
    if (this.isAbstractClass(h)) return undefined

    return objType
  }

  /**
   * 检查 class hierarchy 是否为 abstract class（基于 AST modifiers）
   *
   * @param h
   */
  isAbstractClass(h: ClassHierarchy): boolean {
    if (h.typeDeclaration !== 'class') return false
    const modifiers = h.value?.ast?.node?._meta?.modifiers
    if (!Array.isArray(modifiers)) return false
    return modifiers.includes('abstract')
  }

  // 优先取 _meta.typeDeclaration，缺失时按 isInterface 兜底避免 implements 退化为 extends
  private inferTypeDeclaration(val: any): 'class' | 'interface' {
    if (val?.ast?.node?._meta?.typeDeclaration) return val.ast.node._meta.typeDeclaration
    if (val?.ast?.node?._meta?.isInterface || val?.isInterface) return 'interface'
    return 'class'
  }
}
