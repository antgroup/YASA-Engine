import TypeRelatedInfoResolver from '../common/type-related-info-resolver'
import type { ClassHierarchy } from '../common/value/class-hierarchy'

const QidUnifyUtil = require('../../util/qid-unify-util')
const { getValueFromPackageByQid } = require('../../engine/util/value-util')

/**
 * JavaTypeRelatedInfoResolver
 */
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

    for (const classValUuid of analyzer.classMap.values()) {
      const classVal = analyzer.symbolTable.get(classValUuid)
      if (!classVal.ast.node) {
        continue
      }

      let classHierarchy = resultMap.get(classVal.logicalQid)
      if (!classHierarchy) {
        classHierarchy = {
          typeDeclaration: classVal.ast.node._meta?.typeDeclaration ? classVal.ast.node._meta.typeDeclaration : 'class',
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
        const superClsVal = this.getMemberValueNoCreate(classVal, superAst, state)
        const superClsName = superClsVal ? superClsVal.logicalQid : superAst.name
        let superClassHierarchy = resultMap.get(superClsName)
        if (!superClassHierarchy) {
          superClassHierarchy = {
            typeDeclaration: superClsVal?.ast?.node?._meta?.typeDeclaration ? superClsVal.ast.node._meta.typeDeclaration : 'class',
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
}
