import TypeRelatedInfoResolver from '../common/type-related-info-resolver'
import type { ClassHierarchy } from '../common/value/class-hierarchy'

/**
 * Go 结构化类型匹配：通过 duck typing 判断 struct 是否实现 interface
 */
export default class GoTypeRelatedInfoResolver extends TypeRelatedInfoResolver {
  /**
   * 构建 ClassHierarchy，基于 Go 的结构化类型匹配（duck typing）
   * interface 方法从 AST 提取（因为 interface 方法签名无 body，不会存入 scope.value）
   * struct 方法从 scope.value 用 for...in 遍历（Proxy 支持 for...in 但不支持 Object.keys）
   */
  override findClassHierarchy(analyzer: any, _state: any): Map<string, ClassHierarchy> {
    if (!analyzer.classMap || analyzer.classMap.size === 0) {
      return new Map()
    }

    const result = new Map<string, ClassHierarchy>()

    // 第一步：为每个 class/interface 构建 ClassHierarchy 节点
    for (const [logicalQid, uuid] of analyzer.classMap as Map<string, string>) {
      const classVal = analyzer.symbolTable.get(uuid)
      if (!classVal) continue

      const node: ClassHierarchy = {
        typeDeclaration: classVal.isInterface ? 'interface' : 'class',
        type: classVal.logicalQid || classVal.qid,
        value: classVal,
        extends: [],
        extendedBy: [],
        implements: [],
        implementedBy: [],
      }
      result.set(logicalQid, node)
    }

    // 第二步：收集每个 interface 的方法名集合（从 AST 提取，跳过空接口）
    const interfaceMethods = new Map<string, Set<string>>()
    for (const [logicalQid, node] of result) {
      if (node.typeDeclaration !== 'interface') continue

      const methods = new Set<string>()
      const classVal = node.value
      // interface 方法签名无 body，processFunctionDefinition 不会 createFuncScope
      // 因此必须从 AST 的 ClassDefinition body 中提取方法名
      const astCdef = classVal.ast?.cdef
      const astNode = classVal.ast?.node
      const src = astCdef || astNode
      // Go UAST 的 ClassDefinition body 直接是数组（不是 {type: 'Block', body: [...]}）
      const bodyNodes = Array.isArray(src?.body) ? src.body
        : Array.isArray(src?.body?.body) ? src.body.body
        : []
      for (const bodyNode of bodyNodes) {
        // Go interface body：方法签名是 FuncType，普通 interface 中也可能是 FunctionDefinition
        const name = bodyNode.id?.name
        if (name && (bodyNode.type === 'FunctionDefinition' || bodyNode.type === 'FuncType')) {
          methods.add(name)
        }
      }

      // 跳过空接口（interface{}）
      if (methods.size === 0) continue
      interfaceMethods.set(logicalQid, methods)
    }

    // 第三步：对每个 struct，检查是否满足某个 interface 的全部方法
    for (const [_structQid, structNode] of result) {
      if (structNode.typeDeclaration !== 'class') continue

      // 收集 struct 的方法名集合
      // for...in 能遍历 EntityValue Proxy 的成员，Object.keys() 不能
      const structMethods = new Set<string>()
      const classVal = structNode.value
      if (classVal.value) {
        for (const key in classVal.value) {
          const member = classVal.value[key]
          if (member?.vtype === 'fclos') {
            structMethods.add(key)
          }
        }
      }

      // 与每个 interface 进行方法匹配
      for (const [ifaceQid, ifaceMethods] of interfaceMethods) {
        if (structMethods.size < ifaceMethods.size) continue

        const implementsAll = [...ifaceMethods].every(m => structMethods.has(m))
        if (!implementsAll) continue

        const ifaceNode = result.get(ifaceQid)
        if (!ifaceNode) continue

        // 建立双向关系
        structNode.implements.push(ifaceNode)
        ifaceNode.implementedBy.push(structNode)
      }
    }
    return result
  }
}
