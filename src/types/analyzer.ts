// Analyzer 相关类型定义

/**
 * 作用域
 */
export interface Scope {
    qid: string;
    [key: string]: any;
}

/**
 * 分析状态
 *
 * 核心字段由 initState() 创建，运行时字段在 executeFdeclOrExecute 等处追加。
 * 索引签名暂时保留，待所有消费方迁移完成后删除。
 */
export interface State {
    // 核心（initState 创建）
    pcond: any[];
    callstack: any[];
    brs: string;
    binfo: Record<string, any>;
    einfo: Record<string, any>;
    this?: any;

    // 运行时（executeFdeclOrExecute / memState 追加）
    callsites?: any[];
    parent?: State;
    br_index?: number;

    // 语言特有（动态添加/删除）
    throwstack?: any[];
    throwstackScopeAndState?: Array<{ scope: any; state: State }>;
    entryPointStartTimestamp?: number;
    findIdInCurScope?: boolean;
    tid?: string;

    // 过渡：待消除
    [key: string]: any;
}

/**
 * 分析值 - 从 value.ts 导出强类型
 */
export type {
    Value,
    ValueBase,
    PrimitiveValue,
    ObjectValue,
    ScopedValue,
    FunctionValue,
    UndefinedValue,
    UninitializedValue,
    UnknownValue,
    UnionValue,
    SymbolValue,
    BVTValue,
    PackageValue,
    TypedValue,
    TaintedValue,
    VoidValue,
    SpreadValue,
    BinaryExprValue,
    UnaryExprValue,
    MemberExprValue,
    CallExprValue,
    IdentifierRefValue,
    // 类型守卫
    isPrimitive,
    isObject,
    isScoped,
    isFunction,
    isUndefined,
    isUninitialized,
    isUnknown,
    isUnion,
    isSymbol,
    isBVT,
    isPackage,
    isTyped,
    isTainted,
    isVoid,
    isSpread,
} from './value';
