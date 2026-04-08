import { AstRef } from './ast-ref'
import type { AstNodeStore } from './ast-ref'
import type { BaseNode } from '../../../../types/uast'

/**
 * AstRefList — 内部存 AstRef[]，对外表现像 AST node[]
 *
 * push/set 自动将 AST node 转为 AstRef 存储
 * get/遍历/length 自动 resolve 为 AST node
 * 序列化时通过 _refs 访问内部 AstRef[]
 */
export class AstRefList {
  _refs: AstRef[] = []
  private _getASTManager: () => AstNodeStore | null

  constructor(getASTManager: () => AstNodeStore | null) {
    this._getASTManager = getASTManager
  }

  get length(): number {
    return this._refs.length
  }

  set length(val: number) {
    this._refs.length = val
  }

  get(index: number): BaseNode | undefined {
    const ref = this._refs[index]
    if (!ref) return undefined
    const am = this._getASTManager()
    return am ? ref.resolve(am) ?? undefined : undefined
  }

  push(...nodes: (BaseNode | AstRef)[]): number {
    for (const node of nodes) {
      if (node instanceof AstRef) {
        this._refs.push(node)
      } else {
        const ref = AstRef.fromNode(node)
        if (ref) this._refs.push(ref)
      }
    }
    return this._refs.length
  }

  set(index: number, node: BaseNode | AstRef): void {
    const ref = node instanceof AstRef ? node : AstRef.fromNode(node)
    if (ref && index >= 0 && index < this._refs.length) {
      this._refs[index] = ref
    }
  }

  [Symbol.iterator](): Iterator<BaseNode> {
    const am = this._getASTManager()
    const refs = this._refs
    let i = 0
    return {
      next(): IteratorResult<BaseNode> {
        while (i < refs.length) {
          const node = am ? refs[i].resolve(am) : null
          i++
          if (node) return { value: node, done: false }
        }
        return { value: undefined as unknown as BaseNode, done: true }
      },
    }
  }

  map<T>(fn: (node: BaseNode, index: number) => T): T[] {
    const am = this._getASTManager()
    const result: T[] = []
    for (let i = 0; i < this._refs.length; i++) {
      const node = am ? this._refs[i].resolve(am) : null
      if (node) result.push(fn(node, i))
    }
    return result
  }

  filter(fn: (node: BaseNode, index: number) => boolean): BaseNode[] {
    const am = this._getASTManager()
    const result: BaseNode[] = []
    for (let i = 0; i < this._refs.length; i++) {
      const node = am ? this._refs[i].resolve(am) : null
      if (node && fn(node, i)) result.push(node)
    }
    return result
  }

  forEach(fn: (node: BaseNode, index: number) => void): void {
    const am = this._getASTManager()
    for (let i = 0; i < this._refs.length; i++) {
      const node = am ? this._refs[i].resolve(am) : null
      if (node) fn(node, i)
    }
  }

  static from(items: (BaseNode | AstRef | string)[], getASTManager: () => AstNodeStore | null): AstRefList {
    const list = new AstRefList(getASTManager)
    for (const item of items) {
      if (item instanceof AstRef) {
        list._refs.push(item)
      } else if (typeof item === 'string') {
        list._refs.push(new AstRef(item))
      } else {
        const ref = AstRef.fromNode(item)
        if (ref) list._refs.push(ref)
      }
    }
    return list
  }

  _clone(getASTManager: () => AstNodeStore | null): AstRefList {
    const copy = new AstRefList(getASTManager)
    copy._refs = this._refs.slice()
    return copy
  }
}
