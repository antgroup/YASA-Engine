/**
 * go-analyzer 根因修复（Phase 2.2 方向 A）单元测试
 *
 * 覆盖 W7 三处改动：
 *   - 改动 1：_resolveFieldTypeViaTypeChain helper（新增）
 *   - 改动 2：accessValueFromDefScope 优先用字段声明类型（通过 prototype 方法直接调用验证）
 *   - 改动 3：_getImplReceiverTypeNode helper（CHA dispatch 按 impl 重建 _this.rtype 的输入）
 *
 * 说明：GoAnalyzer 继承 Analyzer，构造器需要完整 symbolInterpret 上下文；这里直接引用 prototype
 * 方法，把 helper 所需的 topScope.context.packages / _methodResolveCache 作为最小 mock 挂上，
 * 不走 processInstruction / checkerManager。重点是验证新 helper 的纯数据遍历 + 缓存语义正确。
 */
import { describe, it, beforeEach } from 'mocha'
import * as assert from 'assert'
const GoAnalyzer = require('../../src/engine/analyzer/golang/common/go-analyzer')

/** 构造一个最小的 GoAnalyzer 替身：只含 helper 需要的字段，方法从 prototype 借过来。 */
function makeAnalyzerStub(packages: any): any {
  const stub: any = {
    topScope: { context: { packages } },
    _methodResolveCache: Object.create(null) as Record<string, any>,
  }
  // 借用 helper 方法（不依赖构造器）
  stub._findAllClassDefsByName = GoAnalyzer.prototype._findAllClassDefsByName
  stub._getClassDefBodyStmts = GoAnalyzer.prototype._getClassDefBodyStmts
  stub._extractTypeName = GoAnalyzer.prototype._extractTypeName
  stub._resolveFieldTypeViaTypeChain = GoAnalyzer.prototype._resolveFieldTypeViaTypeChain
  stub._getImplReceiverTypeNode = GoAnalyzer.prototype._getImplReceiverTypeNode
  stub._searchMethodInPackages = GoAnalyzer.prototype._searchMethodInPackages
  return stub
}

/** 构造 packages 树：MySQLProvider struct 带 `dbHandle *sql.DB` 字段；sqlQuerier interface 无字段。 */
function buildMockPackages() {
  const dbHandleVarDecl = {
    type: 'VariableDeclaration',
    id: { type: 'Identifier', name: 'dbHandle' },
    varType: { type: 'PointerType', element: { type: 'MemberAccess', property: { name: 'DB' } } },
  }
  const mysqlCdef = {
    body: [dbHandleVarDecl, {
      type: 'VariableDeclaration',
      id: { type: 'Identifier', name: 'sqlPlaceholderFormat' },
      varType: { type: 'Identifier', name: 'string' },
    }],
  }
  const mysqlClassDef = {
    sid: 'MySQLProvider',
    isInterface: false,
    ast: { cdef: mysqlCdef },
  }
  const sqliteCdef = {
    body: [{
      type: 'VariableDeclaration',
      id: { type: 'Identifier', name: 'dbHandle' },
      varType: { type: 'PointerType', element: { type: 'MemberAccess', property: { name: 'DB' } } },
    }],
  }
  const sqliteClassDef = {
    sid: 'SQLiteProvider',
    isInterface: false,
    ast: { cdef: sqliteCdef },
  }
  // sqlQuerier interface（body 是方法签名，无字段）
  const sqlQuerierCdef = {
    body: [{
      type: 'FunctionDefinition',
      id: { type: 'Identifier', name: 'QueryContext' },
    }],
  }
  const sqlQuerierClassDef = {
    sid: 'sqlQuerier',
    isInterface: true,
    ast: { cdef: sqlQuerierCdef },
  }

  // packages 结构：顶层 package dataprovider，含上述三个 ClassDefinition
  return {
    value: {
      dataprovider: {
        vtype: 'package',
        value: {
          MySQLProvider: mysqlClassDef,
          SQLiteProvider: sqliteClassDef,
          sqlQuerier: sqlQuerierClassDef,
        },
      },
    },
  }
}

describe('go-analyzer × Phase 2.2 根因修复 helper', () => {
  let analyzer: any
  beforeEach(() => {
    analyzer = makeAnalyzerStub(buildMockPackages())
  })

  describe('_resolveFieldTypeViaTypeChain（改动 1）', () => {
    it('RF-1: struct + 命中字段 → 返回字段声明 varType', () => {
      const t = analyzer._resolveFieldTypeViaTypeChain('MySQLProvider', 'dbHandle')
      assert.ok(t, 'expected varType node, got null')
      assert.strictEqual(t.type, 'PointerType', 'expected PointerType varType')
    })

    it('RF-2: struct + 未命中字段 → 返回 null（走 accessValueFromDefScope 原 fallback）', () => {
      const t = analyzer._resolveFieldTypeViaTypeChain('MySQLProvider', 'notAField')
      assert.strictEqual(t, null)
    })

    it('RF-3: interface（无字段）→ 返回 null，不把接口方法误当字段', () => {
      // sqlQuerier 是 interface；body 里是 FunctionDefinition，不是 VariableDeclaration
      const t = analyzer._resolveFieldTypeViaTypeChain('sqlQuerier', 'QueryContext')
      assert.strictEqual(t, null, 'interface 不应命中字段查询')
    })

    it('RF-4: 未知 parentType → 返回 null', () => {
      const t = analyzer._resolveFieldTypeViaTypeChain('UnknownStruct', 'field')
      assert.strictEqual(t, null)
    })

    it('RF-5: 缓存命中（同 key 第二次查表不应重新遍历 packages）', () => {
      const t1 = analyzer._resolveFieldTypeViaTypeChain('MySQLProvider', 'dbHandle')
      // 污染缓存
      analyzer._methodResolveCache['fieldType:MySQLProvider:dbHandle'] = 'CACHED_SENTINEL'
      const t2 = analyzer._resolveFieldTypeViaTypeChain('MySQLProvider', 'dbHandle')
      assert.strictEqual(t2, 'CACHED_SENTINEL')
      assert.notStrictEqual(t1, 'CACHED_SENTINEL')
    })

    it('RF-6: 空 parentTypeName / fieldName → 返回 null 不报错', () => {
      assert.strictEqual(analyzer._resolveFieldTypeViaTypeChain('', 'dbHandle'), null)
      assert.strictEqual(analyzer._resolveFieldTypeViaTypeChain('MySQLProvider', ''), null)
    })

    it('RF-7: 多个同名 struct 时命中第一个含字段的候选', () => {
      // 再往 packages 里塞一个同名 MySQLProvider（无 dbHandle 字段）
      const extra = {
        sid: 'MySQLProvider',
        isInterface: false,
        ast: { cdef: { body: [] } },
      }
      ;(analyzer.topScope.context.packages.value as any).extraPkg = {
        vtype: 'package',
        value: { MySQLProvider: extra },
      }
      // 清缓存
      analyzer._methodResolveCache = Object.create(null)
      const t = analyzer._resolveFieldTypeViaTypeChain('MySQLProvider', 'dbHandle')
      assert.ok(t, '应找到含 dbHandle 字段的候选')
      assert.strictEqual(t.type, 'PointerType')
    })
  })

  describe('_getImplReceiverTypeNode（改动 3 配套）', () => {
    it('IR-1: implFclos.parent 带 sid → 返回 Identifier(typeName)', () => {
      const implFclos = { parent: { sid: 'MySQLProvider' } }
      const n = analyzer._getImplReceiverTypeNode(implFclos)
      assert.deepStrictEqual(n, { type: 'Identifier', name: 'MySQLProvider' })
    })

    it('IR-2: parent.sid 为空 + logicalQid 带包名 → 取短名', () => {
      const implFclos = { parent: { logicalQid: 'dataprovider.SQLiteProvider' } }
      const n = analyzer._getImplReceiverTypeNode(implFclos)
      assert.deepStrictEqual(n, { type: 'Identifier', name: 'SQLiteProvider' })
    })

    it('IR-3: 没有 parent → 返回 null（CHA dispatch 会退回共享 _this）', () => {
      assert.strictEqual(analyzer._getImplReceiverTypeNode({}), null)
      assert.strictEqual(analyzer._getImplReceiverTypeNode(null), null)
    })

    it('IR-4: parent 上字段为非字符串 → 返回 null', () => {
      assert.strictEqual(analyzer._getImplReceiverTypeNode({ parent: { sid: 42 } }), null)
    })
  })

  describe('accessValueFromDefScope 语义（改动 2，通过 _resolveFieldTypeViaTypeChain 间接覆盖）', () => {
    it('AV-1: interface receiver field access → helper 返回 null，接 accessValueFromDefScope 原 fallback（继承 receiver rtype）', () => {
      // interface 无字段 → helper null → accessValueFromDefScope 分支走 parentTypeNode（原 fallback）
      const helperResult = analyzer._resolveFieldTypeViaTypeChain('sqlQuerier', 'dbHandle')
      assert.strictEqual(helperResult, null, 'interface 路径必须保留原 fallback')
    })

    it('AV-2: struct receiver field access → helper 返回字段类型，accessValueFromDefScope 用字段类型覆盖 definiteType', () => {
      const fieldType = analyzer._resolveFieldTypeViaTypeChain('MySQLProvider', 'dbHandle')
      assert.ok(fieldType, 'struct 路径必须命中字段声明类型')
      assert.strictEqual(fieldType.type, 'PointerType')
    })
  })

  describe('_extractTypeName 复合 AST 节点（Step 1：扩支持 ArrayType/MapType/DereferenceExpression/UnaryExpression*）', () => {
    it('ET-1: ArrayType-of-Identifier → 取元素类型名 "VmDesc"', () => {
      const node = { type: 'ArrayType', element: { type: 'Identifier', name: 'VmDesc' } }
      assert.strictEqual(analyzer._extractTypeName(node), 'VmDesc')
    })

    it('ET-2: ArrayType-of-PointerType → 递归到指针元素的 Identifier "User"', () => {
      const node = {
        type: 'ArrayType',
        element: { type: 'PointerType', element: { type: 'Identifier', name: 'User' } },
      }
      assert.strictEqual(analyzer._extractTypeName(node), 'User')
    })

    it('ET-3: MapType-of-Identifier → 取 valueType 类型名 "VmDesc"（key 类型忽略）', () => {
      const node = {
        type: 'MapType',
        keyType: { type: 'Identifier', name: 'string' },
        valueType: { type: 'Identifier', name: 'VmDesc' },
      }
      assert.strictEqual(analyzer._extractTypeName(node), 'VmDesc')
    })

    it('ET-4: DereferenceExpression(argument=Identifier Tx) → "Tx"（omp-go tx.Begin().Exec 形态）', () => {
      const node = { type: 'DereferenceExpression', argument: { type: 'Identifier', name: 'Tx' } }
      assert.strictEqual(analyzer._extractTypeName(node), 'Tx')
    })

    it('ET-5: UnaryExpression(operator="*", argument=Identifier DB) → "DB"', () => {
      const node = {
        type: 'UnaryExpression',
        operator: '*',
        argument: { type: 'Identifier', name: 'DB' },
      }
      assert.strictEqual(analyzer._extractTypeName(node), 'DB')
    })

    it('ET-6: PointerType-of-ArrayType-of-Identifier → 嵌套递归得 "User"（*[]User 形态）', () => {
      const node = {
        type: 'PointerType',
        element: { type: 'ArrayType', element: { type: 'Identifier', name: 'User' } },
      }
      assert.strictEqual(analyzer._extractTypeName(node), 'User')
    })

    it('ET-7: 不支持的 Literal 节点 → 返回 null（保留回退）', () => {
      const node = { type: 'Literal', value: 1 }
      assert.strictEqual(analyzer._extractTypeName(node), null)
    })
  })

  describe('_searchMethodInPackages hint 守卫（Step 2-B：策略 2 hint-based 重写）', () => {
    /**
     * 构造 packages：
     * - 项目内 dataprovider.MySQLProvider（struct，带 Exec 方法）
     * - 项目内 dataprovider.sqlQuerier（interface，带 Exec 方法）
     * - 项目内 dataprovider.UnrelatedNoExec（struct，无 Exec）
     */
    function buildHintMockPackages() {
      const execFdef = { type: 'FunctionDefinition', id: { type: 'Identifier', name: 'Exec' }, body: {} }
      const mysqlClassDef = {
        sid: 'MySQLProvider',
        isInterface: false,
        ast: { cdef: { body: [] } },
        value: { Exec: { ast: { fdef: execFdef } } },
      }
      const queryIfaceClassDef = {
        sid: 'sqlQuerier',
        isInterface: true,
        ast: { cdef: { body: [] } },
        value: { Exec: { ast: { fdef: execFdef } } },
      }
      const unrelatedClassDef = {
        sid: 'UnrelatedNoExec',
        isInterface: false,
        ast: { cdef: { body: [] } },
        value: {},
      }
      return {
        value: {
          dataprovider: {
            vtype: 'package',
            value: {
              MySQLProvider: mysqlClassDef,
              sqlQuerier: queryIfaceClassDef,
              UnrelatedNoExec: unrelatedClassDef,
            },
          },
        },
      }
    }

    let hintAnalyzer: any
    beforeEach(() => {
      hintAnalyzer = makeAnalyzerStub(buildHintMockPackages())
    })

    it('SM-1: hint.isExternal=true → 直接 return null（外部类型让 res.rtype 兜底）', () => {
      const result = hintAnalyzer._searchMethodInPackages('Exec', {
        parentTypeName: 'MySQLProvider',
        isExternal: true,
      })
      assert.strictEqual(result, null)
    })

    it('SM-2: parentTypeName 缺失 → return null（不做无父类型名的全局深搜）', () => {
      const r1 = hintAnalyzer._searchMethodInPackages('Exec', {})
      assert.strictEqual(r1, null)
      const r2 = hintAnalyzer._searchMethodInPackages('Exec', { parentTypeName: null })
      assert.strictEqual(r2, null)
      const r3 = hintAnalyzer._searchMethodInPackages('Exec', { parentTypeName: '' })
      assert.strictEqual(r3, null)
    })

    it('SM-3: parentTypeName 项目内有 ClassDef + 方法存在 → 命中返回 fclos', () => {
      const result = hintAnalyzer._searchMethodInPackages('Exec', {
        parentTypeName: 'MySQLProvider',
        isExternal: false,
      })
      assert.ok(result, 'expected method fclos, got null')
      assert.ok(result.ast?.fdef, 'expected fdef on method fclos')
    })

    it('SM-4: parentTypeName 项目内只命中 interface → 排除 isInterface=true，return null', () => {
      const result = hintAnalyzer._searchMethodInPackages('Exec', {
        parentTypeName: 'sqlQuerier',
        isExternal: false,
      })
      assert.strictEqual(result, null, 'interface 命中应被排除（避免接口名误绑实现）')
    })

    it('SM-5: methodName 不存在 / parentTypeName 在项目外 → return null', () => {
      const r1 = hintAnalyzer._searchMethodInPackages('NotExist', {
        parentTypeName: 'MySQLProvider',
      })
      assert.strictEqual(r1, null, 'methodName 不存在应 return null')
      const r2 = hintAnalyzer._searchMethodInPackages('Exec', {
        parentTypeName: 'NoSuchType',
      })
      assert.strictEqual(r2, null, 'parentTypeName 项目外 0 命中应 return null')
    })
  })
})
