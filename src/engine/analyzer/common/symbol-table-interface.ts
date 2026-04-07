/**
 * 符号表管理器接口：定义符号表管理器的统一接口
 * SymbolTableManager 和 TemporarySymbolTableManager 都应该实现此接口
 */
export interface ISymbolTableManager {
  /**
   * 计算 Unit 的 UUID
   * @param unit Unit 对象
   * @param qidSuffix 方便计算qid修改时新的uuid
   * @returns UUID，如果无法计算则返回 null
   */
  calculateUUID(unit: any, qidSuffix?: string): string | null

  /**
   * 注册 Unit 对象并返回其 UUID
   * @param unit Unit 对象
   * @param needUpdate 是否需要更新引用（可选）
   * @returns Unit 对象的 UUID
   */
  register(unit: any, needUpdate?: boolean): string | null

  /**
   * 根据 UUID 获取 Unit 对象
   * @param uuid Unit 对象的 UUID
   * @returns Unit 对象，如果不存在则返回 null
   */
  get(uuid: string | null | undefined): any

  /**
   * 检查 UUID 是否存在
   * @param uuid Unit 对象的 UUID
   * @returns 是否存在
   */
  has(uuid: string | null | undefined): boolean

  /**
   * 删除 Unit 对象
   * @param uuid Unit 对象的 UUID
   */
  delete(uuid: string | null | undefined): void

  /**
   * 清空所有 Unit 对象
   */
  clear(): void

  /**
   * 获取已注册的 Unit 对象数量
   * @returns 对象数量
   */
  size(): number

  /**
   * 获取符号表的 Map 对象
   * @returns 符号表的 Map
   */
  getMap(): Map<string, any>
}
