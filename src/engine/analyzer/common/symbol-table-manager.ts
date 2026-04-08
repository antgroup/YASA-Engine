import { yasaError } from "../../../util/format-util"

const { md5 } = require('../../../util/hash-util')
const { yasaWarning } = require('../../../util/format-util')
/**
 * 符号表管理器：管理符号表，负责计算 UUID、注册 Unit 对象等操作
 * 用于降低内存占用，parent 和 field 中只存储 UUID，而不是完整的 Unit 对象
 * 实现 ISymbolTableManager 接口
 */
class SymbolTableManager {
  private symbolMap: Map<string, any> // 符号表：使用 UUID 作为 key 存储 Unit 对象

  /**
   * 构造函数
   */
  constructor() {
    this.symbolMap = new Map()
  }

  /**
   * 计算 Unit 的 UUID
   * UUID = md5(astNodehash + valueType + qid)
   * valueType 使用 constructor.name（如 FunctionValue/SymbolValue），比 vtype 更精确
   * @param unit Unit 对象
   * @param qidSuffix
   * @returns UUID，如果无法计算则返回 null
   */
  calculateUUID(unit: any, qidSuffix?: string): string | null {
    if (!unit) {
      return null
    }

    const parts: string[] = []

    const astNodehash = unit.ast?.node?._meta?.nodehash || ''
    parts.push(astNodehash)

    // Value 类型名（constructor.name），比 vtype 更精确地区分不同 Value 子类
    const valueType = unit.constructor?.name || ''
    parts.push(valueType)

    // qid
    let qid = unit.qid || ''
    if (qidSuffix && qidSuffix !== '') {
      qid += qidSuffix
    }
    parts.push(qid)

    const joined = parts.join('_')
    const md5Id = md5(joined)
    return `symuuid_${md5Id}`
  }

  /**
   * 注册 Unit 对象并返回其 UUID
   * @param unit Unit 对象
   * @returns Unit 对象的 UUID
   */
  register(unit: any): string | null {
    if (!unit || typeof unit !== 'object') {
      return null
    }

    // 计算 UUID
    const uuid = this.calculateUUID(unit)
    if (!uuid) {
      return null
    }

    // 碰撞检测：同 uuid 不同对象且不同类型 → 警告
    const existing = this.symbolMap.get(uuid)
    if (existing && existing !== unit) {
      if (existing.vtype !== unit.vtype || existing.constructor?.name !== unit.constructor?.name) {
        yasaError(`UUID cross-type collision: ${uuid} (qid=${unit.qid}, vtype=${unit.vtype}, ctor=${unit.constructor?.name}) overwrites (vtype=${existing.vtype}, ctor=${existing.constructor?.name})`)
      }
    }

    // 设置 UUID
    unit.uuid = uuid

    // 注册到符号表
    this.symbolMap.set(uuid, unit)

    return uuid
  }

  /**
   * 根据 UUID 获取 Unit 对象
   * @param uuid Unit 对象的 UUID
   * @returns Unit 对象，如果不存在则返回 null
   */
  get(uuid: string | null | undefined): any {
    if (!uuid) {
      return null
    }
    return this.symbolMap.get(uuid) || null
  }

  /**
   * 检查 UUID 是否存在
   * @param uuid Unit 对象的 UUID
   * @returns 是否存在
   */
  has(uuid: string | null | undefined): boolean {
    if (!uuid) {
      return false
    }
    return this.symbolMap.has(uuid)
  }

  /**
   * 删除 Unit 对象（通常不需要，但提供清理功能）
   * @param uuid Unit 对象的 UUID
   */
  delete(uuid: string | null | undefined): void {
    if (uuid) {
      this.symbolMap.delete(uuid)
    }
  }

  /**
   * 清空所有 Unit 对象
   */
  clear(): void {
    this.symbolMap.clear()
  }

  /**
   * 获取已注册的 Unit 对象数量
   * @returns 对象数量
   */
  size(): number {
    return this.symbolMap.size
  }

  /**
   * 获取symbolmap
   */
  getMap(): Map<string, any> {
    return this.symbolMap
  }
}

module.exports = SymbolTableManager
