import TypeRelatedInfoResolver from '../common/type-related-info-resolver'
import type { ClassHierarchy } from '../common/value/class-hierarchy'

/**
 * 多态性还未实现，暂不建议使用
 */
export default class GoTypeRelatedInfoResolver extends TypeRelatedInfoResolver {
  /**
   * find class hierarchy
   * @param analyzer
   * @param state
   * @returns {Map<string, ClassHierarchy>}
   */
  findClassHierarchy(analyzer: any, state: any): Map<string, ClassHierarchy> {
    // TODO
    return new Map()
  }
}
