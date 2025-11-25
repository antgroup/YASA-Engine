import TypeRelatedInfoResolver from '../common/type-related-info-resolver'
import type { ClassHierarchy } from '../common/value/class-hierarchy'

/**
 * JavaTypeRelatedInfoResolver
 */
export default class JavaTypeRelatedInfoResolver extends TypeRelatedInfoResolver {
  /**
   * find class hierarchy
   * @param analyzer
   * @param state
   * @returns {Map<string, ClassHierarchy>}
   */
  findClassHierarchy(analyzer: any, state: any): Map<string, ClassHierarchy> {
    const resultMap: Map<string, ClassHierarchy> = new Map()
    if (!analyzer.classMap) {
      return resultMap
    }

    for (const classVal of analyzer.classMap.values()) {
      if (!classVal.ast) {
        continue
      }

      let classHierarchy = resultMap.get(classVal._qid)
      if (!classHierarchy) {
        classHierarchy = {
          typeDeclaration: classVal.ast._meta?.typeDeclaration ? classVal.ast._meta.typeDeclaration : 'class',
          type: classVal._qid,
          value: classVal,
          extends: [],
          extendedBy: [],
          implements: [],
          implementedBy: [],
        }
        resultMap.set(classVal._qid, classHierarchy)
      }

      if (!Array.isArray(classVal.ast?.supers) || classVal.ast.supers.length === 0) {
        continue
      }

      for (const superAst of classVal.ast.supers) {
        const superClsVal = this.getMemberValueNoCreate(classVal, superAst, state)
        const superClsName = superClsVal ? superClsVal._qid : superAst.name
        let superClassHierarchy = resultMap.get(superClsName)
        if (!superClassHierarchy) {
          superClassHierarchy = {
            typeDeclaration: superClsVal?.ast?._meta?.typeDeclaration ? superClsVal.ast._meta.typeDeclaration : 'class',
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

    return resultMap
  }
}
