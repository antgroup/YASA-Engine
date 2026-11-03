import type { FunctionDefinition } from '../../../../../types/uast'
import type Unit from '../../../common/value/unit'
import { IdentifierRefValue } from '../../../common/value/identifier-ref'

const GRPC_OBSERVER = 'io.grpc.stub.StreamObserver'

type ObserverValue = Unit & {
  value?: unknown
  members?: Map<string, Unit>
  getRawValue?: () => unknown
}

export interface GrpcObserverCallback {
  receiver: Unit
  method: Unit
  request: IdentifierRefValue
  definition: FunctionDefinition
}

export class GrpcStreamObserverModel {
  /** 只有完整类型名或显式导入能证明 gRPC 身份，同名业务接口不能触发桥接。 */
  static isObserverType(type: unknown, imports: readonly unknown[]): boolean {
    const node = type as { id?: { name?: string }; name?: string } | undefined
    const name = (node?.id?.name ?? node?.name ?? '').replace(/<.*>/g, '')
    if (name === GRPC_OBSERVER) return true
    if (name !== 'StreamObserver') return false
    return imports.some((statement: unknown): boolean => {
      const declaration = statement as {
        id?: { name?: string }
        varType?: { id?: { name?: string } }
        init?: { type?: string; from?: { value?: string }; imported?: { name?: string } }
      }
      if (declaration.init?.type !== 'ImportExpression') return false
      const imported = declaration.varType?.id?.name
        ?? `${declaration.init.from?.value}.${declaration.init.imported?.name ?? declaration.id?.name}`
      return imported === GRPC_OBSERVER
    })
  }

  /** 返回值可能由分支合并产生，沿值容器展开而不遍历任意对象字段。 */
  private static leaves(value: Unit | undefined, seen: Set<Unit> = new Set()): Unit[] {
    if (!value || seen.has(value)) return []
    seen.add(value)
    if (value.vtype !== 'union' && value.vtype !== 'BVT') return [value]
    const container = value as ObserverValue
    const children = value.vtype === 'union' ? container.value : container.getRawValue?.()
    return Array.isArray(children) ? children.flatMap((child: Unit): Unit[] => this.leaves(child, seen)) : []
  }

  /** 将既有入口污点复制到请求参数，保留原始 SOURCE 证据并隔离响应对象类型。 */
  static buildCallbacks(
    definition: FunctionDefinition,
    imports: readonly unknown[],
    source: Unit | undefined,
    returned: Unit | undefined,
  ): GrpcObserverCallback[] {
    if (definition.parameters.length !== 1 || !source?.taint.isTainted) return []
    if (!this.isObserverType(definition.returnType, imports)
      || !this.isObserverType(definition.parameters[0].varType, imports)) return []
    const callbacks: GrpcObserverCallback[] = []
    for (const receiver of this.leaves(returned)) {
      if (receiver === source) continue
      for (const method of this.leaves((receiver as ObserverValue).members?.get('onNext'))) {
        if (method.vtype !== 'fclos') continue
        const callback = method.ast?.fdef as FunctionDefinition | undefined
        if (!callback || callback.body?.type === 'Noop' || callback.parameters.length !== 1) continue
        const parameter = callback.parameters[0]
        const request = new IdentifierRefValue(method.qid, parameter.id.name ?? '', parameter.id, parameter.loc, 'variable')
        request.rtype = { definiteType: parameter.varType?.id }
        request.taint.propagateFrom(source)
        request.taint.propagateTraceFrom(source.taint)
        callbacks.push({ receiver, method, request, definition: callback })
      }
    }
    return callbacks
  }
}
