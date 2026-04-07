import { RAW_TARGET, IS_UNION_ARRAY } from './value/symbols'
import { yasaLog, yasaWarning, yasaError } from '../../../util/format-util'
import { AnalysisContext } from './analysis-context'
import { Scoped } from './value/scoped'
import { ObjectValue } from './value/object'
import { PrimitiveValue } from './value/primitive'
import { SymbolValue } from './value/symbolic'
import { PackageValue } from './value/package'
import { UnionValue } from './value/union'
import { UnknownValue } from './value/unkown'
import { UndefinedValue } from './value/undefine'
import { UninitializedValue } from './value/uninit'
import { FunctionValue } from './value/function'
import { BVTValue } from './value/bvt'
import type { RType } from './value/data-value'

const fs = require('fs')
const path = require('path')
const jsonfile = require('jsonfile')
const util = require('util')
const Config = require('../../../config')
const { writeJSONfile } = require('../../../util/file-util')
const { shallowCopyValue } = require('../../../util/clone-util')
const { Graph } = require('../../../util/graph')

const names: string[] = []

/**
 * 获取缓存目录路径
 */
function getCacheDir(): string {
  const outputDir = Config.contextEnvironmentDir
  if (!outputDir) {
    yasaError(
      '[CACHE]Config.intermediateDir is not set. Please set Config.intermediateDir before using cache functionality.'
    )
    throw new Error(
      'Config.intermediateDir is not set. Please set Config.intermediateDir before using cache functionality.'
    )
  }

  let cacheDir: string
  if (!path.isAbsolute(outputDir)) {
    cacheDir = path.resolve(process.cwd(), outputDir)
  } else {
    cacheDir = outputDir
  }
  return cacheDir
}

/**
 * 序列化对象，处理 astManager 时跳过 parent 属性
 * @param obj 要序列化的对象
 * @param skipParent 是否跳过 parent 属性（用于 astManager）
 * @param maxDepth 最大深度，防止无限递归
 * @param currentDepth 当前深度
 * @param visited 已访问的对象集合，用于检测循环引用
 * @param parentRelations
 * @returns 序列化后的对象
 */
function serializeObject(
  obj: any,
  skipParent: boolean = false,
  maxDepth: number = 100,
  currentDepth: number = 0,
  visited: WeakSet<any> = new WeakSet(),
  parentRelations?: Map<string, string> // 用于记录 parent 关系：nodehash -> parent nodehash
): any {
  if (currentDepth > maxDepth) {
    return '[Max Depth Reached]'
  }

  if (obj == null) {
    return obj
  }

  // 处理基本类型
  if (typeof obj !== 'object') {
    return obj
  }

  // 检测循环引用
  if (visited.has(obj)) {
    return '[Circular Reference]'
  }

  // 处理 Map 类型
  if (obj instanceof Map) {
    visited.add(obj)
    const result: any = {}
    const constructorNames: any = {} // 用于记录每个 unit 的构造函数名称
    for (const [key, value] of obj.entries()) {
      // 检查是否是 topScope 对象（通过 sid 和 qid 判断）
      if (value && typeof value === 'object' && value.sid === '<global>' && value.qid === '<global>') {
        // 用特殊标记替换 topScope
        result[key] = { __yasaTopScopeMarker: true }
      } else if (value != null && typeof value === 'object') {
        // 如果是 Unit 对象（有 vtype 属性），记录其构造函数名称
        if (value.vtype && value.constructor?.name) {
          constructorNames[key] = value.constructor.name
        }
        result[key] = serializeObject(value, skipParent, maxDepth, currentDepth + 1, visited, parentRelations)
      } else {
        result[key] = value
      }
    }
    // 如果有构造函数名称记录，将其添加到结果中
    if (Object.keys(constructorNames).length > 0) {
      result.__yasaConstructorNames = constructorNames
    }
    visited.delete(obj)
    return result
  }

  // 处理 Set 类型
  if (obj instanceof Set) {
    visited.add(obj)
    const result: any[] = []
    for (const item of obj.values()) {
      if (item != null && typeof item === 'object') {
        result.push(serializeObject(item, skipParent, maxDepth, currentDepth + 1, visited, parentRelations))
      } else {
        result.push(item)
      }
    }
    visited.delete(obj)
    return result
  }

  // 处理数组
  if (Array.isArray(obj)) {
    visited.add(obj)
    const result = obj.map((item, index) => {
      if (item != null && typeof item === 'object') {
        return serializeObject(item, skipParent, maxDepth, currentDepth + 1, visited, parentRelations)
      }
      return item
    })
    visited.delete(obj)
    return result
  }

  // 处理对象
  visited.add(obj)

  // 检测是否是 Proxy，如果是则获取原始对象
  let targetObj = obj
  if (util.types.isProxy && util.types.isProxy(obj)) {
    // 尝试获取 Proxy 的原始对象
    if ((obj as any)[RAW_TARGET]) {
      targetObj = (obj as any)[RAW_TARGET]
    } else if ((obj as any)[IS_UNION_ARRAY]) {
      targetObj = (obj as any)[IS_UNION_ARRAY]
    }
  }

  const result: any = {}

  // 使用 Reflect.ownKeys 获取所有属性（包括不可枚举的）
  // 对于 Unit 对象，我们需要同时检查 targetObj 和 obj，因为某些属性（如 astNodehash）可能在原对象上
  // 使用 targetObj 而不是 obj，避免触发 Proxy 的 get trap
  const allKeys = Reflect.ownKeys(targetObj)
  // 对于 Unit 对象，也检查原对象上的属性（如果 targetObj 和 obj 不同）
  const allKeysFromObj = targetObj !== obj ? Reflect.ownKeys(obj) : []
  // 合并两个键集合，确保所有属性都被序列化
  const allKeysSet = new Set([...allKeys, ...allKeysFromObj])

  for (const key of allKeysSet) {
    if (typeof key === 'symbol') {
      continue
    }

    const keyStr = key as string

    // 跳过内部属性和不可序列化的 ValueRefMap/ValueRefList 影子属性
    if (keyStr.startsWith('__yasa') || keyStr === 'elements' || keyStr === '_children' || keyStr === 'set') {
      if (!names.includes(keyStr)) {
        names.push(keyStr)
      }
      continue
    }

    try {
      // 直接访问 targetObj 的属性，避免触发 Proxy 的 get trap
      // 如果 targetObj 上没有该属性，尝试从原对象获取（对于某些属性如 astNodehash）
      let value = Reflect.get(targetObj, keyStr)
      if (value === undefined && targetObj !== obj) {
        // 如果 targetObj 上没有该属性，尝试从原对象获取
        const descriptor = Object.getOwnPropertyDescriptor(obj, keyStr)
        if (descriptor && 'value' in descriptor) {
          value = descriptor.value
        }
      }

      // 处理 parent 属性：记录 parent 的 nodehash 关系
      if (keyStr === 'parent' && value && typeof value === 'object' && value.type) {
        // 这是一个 AST 节点的 parent
        const currentNodehash = targetObj._meta?.nodehash
        const parentNodehash = value._meta?.nodehash
        if (currentNodehash && parentNodehash && parentRelations) {
          // 记录 parent 关系
          parentRelations.set(currentNodehash, parentNodehash)
        }
        // 如果 skipParent 为 true，跳过序列化 parent 对象本身
        if (skipParent) {
          continue
        }
        // 否则继续序列化 parent（但会记录关系）
      }

      // 如果 skipParent 为 true 且是 parent 属性，跳过（但上面已经处理了）
      if (skipParent && keyStr === 'parent') {
        continue
      }

      // 对于 decls 和 overloaded，它们可能是 Proxy，需要访问内部存储
      if (keyStr === 'decls' && util.types.isProxy && util.types.isProxy(value)) {
        // 优先从 _ast._declsMap 读取（AstBinding），回退到 _declsNodehashMap
        const astBinding = Reflect.get(targetObj, '_ast')
        const declsMap = astBinding?._declsMap ?? Reflect.get(targetObj, '_declsNodehashMap')
        if (declsMap instanceof Map) {
          const declsData: any = {}
          for (const [name, entry] of declsMap.entries()) {
            // AstRef 对象取 .hash，裸字符串直接用
            declsData[name] = entry?.hash ?? entry
          }
          result[keyStr] = declsData
        } else {
          result[keyStr] = serializeObject(value, skipParent, maxDepth, currentDepth + 1, visited, parentRelations)
        }
        continue
      }

      if (keyStr === 'overloaded') {
        const overloadedList = Reflect.get(targetObj, 'overloaded')
        if (overloadedList && overloadedList._refs) {
          result[keyStr] = overloadedList._refs.map((ref: any) => ref.hash)
        }
        continue
      }

      // 检查是否是 topScope 对象（通过 sid 和 qid 判断）
      if (value && typeof value === 'object' && value.sid === '<global>' && value.qid === '<global>') {
        // 用特殊标记替换 topScope
        result[keyStr] = { __yasaTopScopeMarker: true }
      } else if (value != null && typeof value === 'object') {
        result[keyStr] = serializeObject(value, skipParent, maxDepth, currentDepth + 1, visited, parentRelations)
      } else {
        // 对于基本类型（字符串、数字、布尔值、null、undefined），直接赋值
        // 注意：JSON.stringify 会忽略 undefined，但会保留 null
        // 为了确保 astNodehash 等属性被正确序列化，即使值是 undefined，我们也应该包含它
        // 但 JSON 不支持 undefined，所以如果值是 undefined，我们将其序列化为 null
        // 不过，为了保持一致性，我们直接赋值，让 JSON.stringify 处理
        result[keyStr] = value
      }
    } catch (e) {
      // 忽略访问器错误
      yasaWarning(`Failed to serialize property ${keyStr}: ${e}`)
    }
  }

  visited.delete(obj)
  return result
}

/**
 * 将大对象分割成多个文件
 * @param data 要分割的数据
 * @param basePath 基础路径
 * @param chunkSize 每个文件的最大条目数（对于 Map，默认 1000）
 * @param isMapData 是否是 Map 数据（序列化后的对象）
 * @returns 保存的文件路径列表
 */
function splitAndSave(data: any, basePath: string, chunkSize: number = 1000, isMapData: boolean = false): string[] {
  const savedFiles: string[] = []

  if (Array.isArray(data)) {
    // 如果是数组，按 chunkSize 分割
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize)
      const chunkPath = `${basePath}.part${Math.floor(i / chunkSize)}.json`
      writeJSONfile(chunkPath, chunk)
      savedFiles.push(chunkPath)
    }
  } else if (typeof data === 'object' && data !== null) {
    const keys = Object.keys(data)
    const mapChunkSize = 1000 // Map 数据使用 1000 作为 chunkSize

    if (isMapData) {
      // Map 数据：无论条目数多少都使用子文件夹结构
      const baseDir = path.dirname(basePath)
      const baseName = path.basename(basePath)
      const mapDir = path.join(baseDir, baseName)

      // 确保目录存在
      if (!fs.existsSync(mapDir)) {
        fs.mkdirSync(mapDir, { recursive: true })
      }

      const mapInfo = {
        totalEntries: keys.length,
        chunkSize: mapChunkSize,
        numChunks: Math.ceil(keys.length / mapChunkSize),
      }
      writeJSONfile(path.join(mapDir, 'info.json'), mapInfo)
      savedFiles.push(path.join(mapDir, 'info.json'))

      // 按 chunkSize 分割，使用文件夹名字作为前缀
      const prefix = baseName // 使用 baseName 作为前缀（如 astMap, symbolMap）
      for (let i = 0; i < keys.length; i += mapChunkSize) {
        const chunkKeys = keys.slice(i, i + mapChunkSize)
        const chunk: any = {}
        for (const key of chunkKeys) {
          chunk[key] = data[key]
        }
        const chunkIndex = Math.floor(i / mapChunkSize)
        const chunkPath = path.join(mapDir, `${prefix}-chunk${chunkIndex}.json`)
        writeJSONfile(chunkPath, chunk)
        savedFiles.push(chunkPath)
      }
    } else {
      // 如果键数量很多，按键分割
      for (let i = 0; i < keys.length; i += chunkSize) {
        const chunkKeys = keys.slice(i, i + chunkSize)
        const chunk: any = {}
        for (const key of chunkKeys) {
          chunk[key] = data[key]
        }
        const chunkPath = `${basePath}.part${Math.floor(i / chunkSize)}.json`
        writeJSONfile(chunkPath, chunk)
        savedFiles.push(chunkPath)
      }
    }
  } else {
    // 其他类型直接保存
    writeJSONfile(`${basePath}.json`, data)
    savedFiles.push(`${basePath}.json`)
  }

  return savedFiles
}

/**
 * 反序列化对象，将 JSON 中的对象转换回 Map 和 Set
 * @param obj 要反序列化的对象
 * @param topScopeRef topScope 对象的引用（用于恢复特殊标记）
 * @param skipParentForAST
 * @returns 反序列化后的对象
 */
function deserializeObject(obj: any, topScopeRef?: any, skipParentForAST?: boolean): any {
  if (obj == null || typeof obj !== 'object') {
    return obj
  }

  // 检查是否是 topScope 特殊标记
  if (obj && typeof obj === 'object' && obj.__yasaTopScopeMarker === true) {
    return topScopeRef || obj
  }

  // 处理数组
  if (Array.isArray(obj)) {
    return obj.map((item) => deserializeObject(item, topScopeRef, skipParentForAST))
  }

  // 检查是否是 Map 的序列化格式（普通对象，但需要特殊处理）
  // 对于 symbolTable，我们需要检查特定的属性名来判断是否需要转换为 Map
  const result: any = {}

  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      continue
    }

    const value = obj[key]

    // 对于 symbolTable 的特殊属性，需要转换为 Map 或 Set
    if (key === 'symbolMap') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // 转换为 Map
        const map = new Map()
        // 检查是否有构造函数名称记录（仅对 symbolMap）
        const constructorNames = key === 'symbolMap' ? value.__yasaConstructorNames : null
        for (const mapKey in value) {
          if (Object.prototype.hasOwnProperty.call(value, mapKey)) {
            // 跳过构造函数名称记录
            if (mapKey === '__yasaConstructorNames') {
              continue
            }
            const mapValue = value[mapKey]
            // 检查是否是 topScope 特殊标记
            if (mapValue && typeof mapValue === 'object' && mapValue.__yasaTopScopeMarker === true) {
              map.set(mapKey, topScopeRef || mapValue)
            } else if (key === 'symbolMap' && constructorNames && constructorNames[mapKey]) {
              // 对于 symbolMap 中的 Unit 对象，根据构造函数名称创建实例，然后复制所有属性
              // 先反序列化对象（获取所有属性）
              const deserializedUnit = deserializeObject(mapValue, topScopeRef, skipParentForAST)
              const constructorName = constructorNames[mapKey]

              // 根据构造函数名称创建新实例（使用最小参数，保持正确的原型链）
              let recreatedUnit: any
              const minimalOpts = {
                sid: deserializedUnit.sid || deserializedUnit._sid || '<temp>',
                qid: deserializedUnit.qid || deserializedUnit._qid || '<temp>',
                parent: deserializedUnit.parent || null,
              }

              switch (constructorName) {
                case 'Scoped':
                  recreatedUnit = Scoped.fromOpts('', minimalOpts)
                  break
                case 'ObjectValue':
                  recreatedUnit = ObjectValue.fromOpts('', minimalOpts)
                  break
                case 'PrimitiveValue':
                  recreatedUnit = PrimitiveValue.fromOpts('', minimalOpts)
                  break
                case 'SymbolValue':
                  recreatedUnit = SymbolValue.fromOpts('', minimalOpts)
                  break
                case 'PackageValue':
                  recreatedUnit = PackageValue.fromOpts('', minimalOpts)
                  break
                case 'UnionValue':
                  recreatedUnit = UnionValue.fromOpts('', minimalOpts)
                  break
                case 'UnknownValue':
                  recreatedUnit = UnknownValue.fromOpts('', minimalOpts)
                  break
                case 'UndefinedValue':
                  recreatedUnit = UndefinedValue.fromOpts('', minimalOpts)
                  break
                case 'UninitializedValue':
                  recreatedUnit = UninitializedValue.fromOpts('', minimalOpts)
                  break
                case 'FunctionValue':
                  recreatedUnit = FunctionValue.fromOpts('', minimalOpts)
                  break
                case 'BVTValue':
                  recreatedUnit = BVTValue.fromOpts('', minimalOpts)
                  break
                default:
                  // 如果不知道构造函数，直接使用反序列化的对象
                  recreatedUnit = deserializedUnit
                  map.set(mapKey, recreatedUnit)
                  continue
              }

              // 将所有属性从反序列化的对象复制到新实例上（使用 Reflect.ownKeys 确保所有属性都被复制）
              const allKeys = Reflect.ownKeys(deserializedUnit)
              for (const propKey of allKeys) {
                if (typeof propKey === 'symbol') {
                  continue
                }
                const propKeyStr = propKey as string
                // 跳过一些不应该直接复制的属性（这些属性会在构造函数中设置）
                if (propKeyStr === 'constructor' || propKeyStr === '__proto__') {
                  continue
                }
                try {
                  const descriptor = Object.getOwnPropertyDescriptor(deserializedUnit, propKeyStr)
                  if (descriptor) {
                    if ('value' in descriptor) {
                      // 直接设置属性值
                      ;(recreatedUnit as any)[propKeyStr] = descriptor.value
                    } else if ('get' in descriptor || 'set' in descriptor) {
                      // 对于 getter/setter，尝试复制描述符
                      try {
                        Object.defineProperty(recreatedUnit, propKeyStr, descriptor)
                      } catch (e) {
                        // 如果无法复制描述符，尝试直接访问值
                        try {
                          ;(recreatedUnit as any)[propKeyStr] = (deserializedUnit as any)[propKeyStr]
                        } catch (e2) {
                          // 忽略错误
                        }
                      }
                    }
                  } else {
                    // 如果没有描述符，尝试直接复制
                    try {
                      ;(recreatedUnit as any)[propKeyStr] = (deserializedUnit as any)[propKeyStr]
                    } catch (e) {
                      // 忽略错误
                    }
                  }
                } catch (e) {
                  // 忽略复制错误
                  yasaWarning(`Failed to copy property ${propKeyStr} to recreated unit: ${e}`)
                }
              }

              map.set(mapKey, recreatedUnit)
            } else {
              // 递归反序列化 Unit 对象，确保所有属性（包括 astNodehash）都被正确恢复
              map.set(mapKey, deserializeObject(mapValue, topScopeRef, skipParentForAST))
            }
          }
        }
        result[key] = map
      } else {
        result[key] = deserializeObject(value, topScopeRef, skipParentForAST)
      }
    } else if (key === 'astMap') {
      // astManager 的 astMap 需要转换为 Map
      // 注意：在反序列化 AST 节点时，需要先跳过 parent 属性，后续再统一设置
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const map = new Map()
        for (const mapKey in value) {
          if (Object.prototype.hasOwnProperty.call(value, mapKey)) {
            const mapValue = value[mapKey]
            // 递归反序列化 AST 节点（跳过 parent，后续统一设置）
            const astNode = deserializeObject(mapValue, topScopeRef, true) // 第三个参数表示跳过 parent
            // 先删除可能存在的 parent 引用（避免指向错误的对象）
            if (astNode && typeof astNode === 'object') {
              delete astNode.parent
            }
            map.set(mapKey, astNode)
          }
        }
        result[key] = map
      } else {
        result[key] = deserializeObject(value, topScopeRef)
      }
    } else {
      // 对于其他属性，递归反序列化
      // 这包括 Unit 对象的所有属性（如 astNodehash、declsNodehash、uuid、parent_uuid 等）
      // 如果是 AST 节点的 parent 属性且 skipParentForAST 为 true，跳过它
      if (skipParentForAST && key === 'parent') {
        // 跳过 parent 属性，后续统一设置
        continue
      }
      result[key] = deserializeObject(value, topScopeRef, skipParentForAST)
    }
  }

  return result
}

/**
 * 从分割的文件中加载数据
 * @param basePath 基础路径
 * @returns 加载的数据
 */
function loadFromSplit(basePath: string): any {
  const baseDir = path.dirname(basePath)
  const baseName = path.basename(basePath)
  const mapDir = path.join(baseDir, baseName)

  // 检查是否存在子文件夹结构（Map 数据）
  if (fs.existsSync(mapDir) && fs.statSync(mapDir).isDirectory()) {
    // 检查是否存在 info.json（表示是分 chunk 的大 Map）
    const mapInfoPath = path.join(mapDir, 'info.json')
    if (fs.existsSync(mapInfoPath)) {
      // 大 Map：从多个 chunk 文件加载
      const mapInfo = jsonfile.readFileSync(mapInfoPath)
      const numChunks = mapInfo.numChunks || 0

      // 加载所有 chunk 并合并，使用文件夹名字作为前缀查找
      const result: any = {}
      const prefix = baseName // 使用 baseName 作为前缀（如 astMap, symbolMap）
      for (let i = 0; i < numChunks; i++) {
        const chunkPath = path.join(mapDir, `${prefix}-chunk${i}.json`)
        if (fs.existsSync(chunkPath)) {
          const chunkData = jsonfile.readFileSync(chunkPath)
          Object.assign(result, chunkData)
        }
      }

      return result
    }
    // 小 Map：从单个文件加载
    const singleFilePath = path.join(mapDir, `${baseName}.json`)
    if (fs.existsSync(singleFilePath)) {
      return jsonfile.readFileSync(singleFilePath)
    }
    // 如果文件夹存在但文件不存在，返回 null
    return null
  }

  // 查找所有分割文件（part 文件）
  const files: string[] = []
  let partIndex = 0

  // 查找所有分割文件
  while (true) {
    const partPath = `${basePath}.part${partIndex}.json`
    if (fs.existsSync(partPath)) {
      files.push(partPath)
      partIndex++
    } else {
      break
    }
  }

  // 如果没有分割文件，尝试加载单个文件
  if (files.length === 0) {
    const singlePath = `${basePath}.json`
    if (fs.existsSync(singlePath)) {
      return jsonfile.readFileSync(singlePath)
    }
    return null
  }

  // 加载所有分割文件并合并
  const allData: any[] = []
  for (const file of files) {
    try {
      const data = jsonfile.readFileSync(file)
      if (Array.isArray(data)) {
        allData.push(...data)
      } else if (typeof data === 'object' && data !== null) {
        allData.push(data)
      }
    } catch (err: any) {
      yasaWarning(`Failed to load cache file ${file}: ${err.message}`)
    }
  }

  if (allData.length === 0) {
    return null
  }

  // 判断原始数据类型
  const firstFile = jsonfile.readFileSync(files[0])
  if (Array.isArray(firstFile)) {
    return allData
  }
  if (typeof firstFile === 'object' && firstFile !== null) {
    // 合并对象
    const result: any = {}
    for (const obj of allData) {
      Object.assign(result, obj)
    }
    return result
  }

  return allData
}

/**
 * 保存分析器缓存
 * @param analyzer 分析器实例
 * @param cacheId 缓存 ID（用于区分不同的缓存，如基于源路径的哈希）
 */
export function saveAnalyzerCache(analyzer: any, cacheId?: string): void {
  try {
    const cacheDir = getCacheDir()
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }

    // 如果没有提供 cacheId，使用默认值
    const id = cacheId || 'default'
    // 创建以 cacheId 命名的文件夹
    const cacheFolder = path.join(cacheDir, id)
    if (!fs.existsSync(cacheFolder)) {
      fs.mkdirSync(cacheFolder, { recursive: true })
    }
    const cacheBasePath = cacheFolder

    yasaLog(`[SAVE CACHE]Saving analyzer cache to ${cacheBasePath}...`)

    // 获取 topScope 的原始对象（绕过 Proxy）
    const topScopeTarget = (analyzer.topScope as any)[RAW_TARGET] || analyzer.topScope

    // a. fileManager
    if (!Config.miniSaveContextEnvironment) {
      if (analyzer.fileManager) {
        const fileManagerData = serializeObject(analyzer.fileManager)
        splitAndSave(fileManagerData, path.join(cacheBasePath, 'fileManager'), 1000, true)
        yasaLog('[SAVE CACHE]Saved fileManager')
      }
    }

    // b. symbolTable
    if (analyzer.symbolTable) {
      const symbolTable = analyzer.symbolTable // 特殊处理 symbolMap：根据 Config.miniSaveContextEnvironment 决定是否简化
      const symbolMap = symbolTable.getMap()
      if (symbolMap instanceof Map) {
        if (Config.miniSaveContextEnvironment) {
          // 简化模式：根据节点类型过滤属性
          const astManager = analyzer.astManager
          const astMap = astManager.getMap()
          if (astMap instanceof Map) {
            const keysToDelete: string[] = []
            for (const [nodehash, node] of astMap.entries()) {
              if (node && typeof node === 'object' && node.type) {
                if (node.type === 'VariableDeclaration') {
                  // 只保留 type、id、varType 属性
                  const allowedProps = ['type', 'id', 'varType', '_meta']
                  const allKeys = Reflect.ownKeys(node)
                  for (const prop of allKeys) {
                    if (typeof prop === 'string' && !allowedProps.includes(prop)) {
                      try {
                        delete (node as any)[prop]
                      } catch (e) {
                        // 忽略删除错误
                      }
                    }
                  }
                } else if (node.type === 'FunctionDefinition') {
                  // 只保留 type、id、parameters、returnType 属性
                  const allowedProps = ['type', 'id', 'parameters', 'returnType', '_meta']
                  const allKeys = Reflect.ownKeys(node)
                  for (const prop of allKeys) {
                    if (typeof prop === 'string' && !allowedProps.includes(prop)) {
                      try {
                        delete (node as any)[prop]
                      } catch (e) {
                        // 忽略删除错误
                      }
                    }
                  }
                } else {
                  // 其他类型，直接从 astMap 删除
                  keysToDelete.push(nodehash)
                }
              }
            }
            // 删除其他类型的节点
            for (const nodehash of keysToDelete) {
              astManager.astMap.delete(nodehash)
            }
          }

          // 简化模式：只保留指定的属性
          const allowedProps = [
            'vtype',
            '_field',
            '_sid',
            '_qid',
            'uuid',
            '_ast',
            '_parentRef',
            '_thisRef',
            '_superRef',
            '_packageScopeRef',
            'overloaded',
            '_scopeCtx',
            'rtype',
          ]

          // 直接遍历 symbolMap，在原对象上删除不需要的属性
          for (const [key, value] of symbolTable.symbolMap.entries()) {
            if (value && typeof value === 'object' && value._ast?._nodeRef) {
              const hash = value._ast._nodeRef.hash
              if (astManager && astManager.astMap instanceof Map) {
                if (!astManager.astMap.has(hash)) {
                  value.ast = null
                }
              } else {
                value.ast = null
              }
            }
            // 检查是否是 topScope 对象（通过 sid 和 qid 判断）
            if (value != null && typeof value === 'object' && value.sid !== '<global>' && value.qid !== '<global>') {
              // 获取所有属性键
              const allKeys = Reflect.ownKeys(value)
              // 删除不在允许列表中的属性
              for (const prop of allKeys) {
                if (typeof prop === 'string' && !allowedProps.includes(prop)) {
                  try {
                    delete (value as any)[prop]
                  } catch (e) {
                    // 忽略删除错误（可能是不可配置的属性）
                  }
                }
                if (prop === 'rtype') {
                  // 只保留 rtype 下的 type 和 name 字段，其他字段去掉
                  const rtype = (value as { rtype?: RType }).rtype
                  if (rtype && typeof rtype === 'object') {
                    const filteredRtype: Partial<RType> = {}
                    if ('type' in rtype) {
                      filteredRtype.type = rtype.type
                    }
                    if ('definiteType' in rtype) {
                      filteredRtype.definiteType = { type: rtype.definiteType?.type, name: rtype.definiteType?.name }
                    }
                    if ('vagueType' in rtype) {
                      filteredRtype.vagueType = rtype.vagueType
                    }
                    ;(value as { rtype: RType }).rtype = filteredRtype as RType
                  }
                }
              }
            }
          }
        } else {
          for (const [key, value] of symbolTable.symbolMap.entries()) {
            // 检查是否是 topScope 对象（通过 sid 和 qid 判断）
            if (value != null && typeof value === 'object' && value.sid !== '<global>' && value.qid !== '<global>') {
              // 获取所有属性键
              const allKeys = Reflect.ownKeys(value)
              // 删除不在允许列表中的属性
              for (const prop of allKeys) {
                if (prop === 'rtype') {
                  // 只保留 rtype 下的 type 和 name 字段，其他字段去掉
                  const rtype = (value as { rtype?: RType }).rtype
                  if (rtype && typeof rtype === 'object') {
                    const filteredRtype: Partial<RType> = {}
                    if ('type' in rtype) {
                      filteredRtype.type = rtype.type
                    }
                    if ('definiteType' in rtype) {
                      filteredRtype.definiteType = { type: rtype.definiteType?.type, name: rtype.definiteType?.name }
                    }
                    if ('vagueType' in rtype) {
                      filteredRtype.vagueType = rtype.vagueType
                    }
                    ;(value as { rtype: RType }).rtype = filteredRtype as RType
                  }
                }
              }
            }
          }
        }
      }

      const symbolTableData = serializeObject(analyzer.symbolTable)

      // 创建 symbolTable 文件夹
      const symbolTableDir = path.join(cacheBasePath, 'symbolTable')
      if (!fs.existsSync(symbolTableDir)) {
        fs.mkdirSync(symbolTableDir, { recursive: true })
      }
      // 特殊处理各个 Map 属性：按每 1000 个条目分割，使用子文件夹结构
      for (const key in symbolTableData) {
        if (Config.miniSaveContextEnvironment && key.includes('funcSymbolTable')) {
          continue
        }
        if (key === '__yasaConstructorNames') {
          continue
        }
        const value = symbolTableData[key]
        if (value && typeof value === 'object') {
          splitAndSave(value, path.join(symbolTableDir, key), 1000, true)
        } else if (typeof value !== 'function') {
          // 基本类型：直接保存
          writeJSONfile(path.join(symbolTableDir, `${key}.json`), value)
        }
      }

      yasaLog('[SAVE CACHE]Saved symbolTable')
    }

    // c. astManager (记录 parent 关系，但不序列化 parent 对象本身)
    if (analyzer.astManager) {
      // 创建 parent 关系映射
      const parentRelations = new Map<string, string>()
      const astManagerData = serializeObject(analyzer.astManager, true, 100, 0, new WeakSet(), parentRelations) // skipParent = true, 但会记录关系

      // 创建 astManager 文件夹
      const astManagerDir = path.join(cacheBasePath, 'astManager')
      if (!fs.existsSync(astManagerDir)) {
        fs.mkdirSync(astManagerDir, { recursive: true })
      }

      // 特殊处理 astMap：按每 1000 个条目分割，使用子文件夹结构
      if (astManagerData.astMap && typeof astManagerData.astMap === 'object') {
        splitAndSave(astManagerData.astMap, path.join(astManagerDir, 'astMap'), 1000, true)
        yasaLog(`[SAVE CACHE]Saved astManager.astMap (${Object.keys(astManagerData.astMap).length} entries)`)
      }

      // 保存 astManager 的其他属性（除了 astMap）
      for (const key in astManagerData) {
        if (key !== 'astMap' && key !== '__yasaConstructorNames') {
          const value = astManagerData[key]
          if (value != null) {
            splitAndSave(value, path.join(astManagerDir, key))
          }
        }
      }

      // 保存 parent 关系映射
      if (!Config.miniSaveContextEnvironment) {
        if (parentRelations.size > 0) {
          const parentRelationsObj: any = {}
          for (const [nodehash, parentNodehash] of parentRelations.entries()) {
            parentRelationsObj[nodehash] = parentNodehash
          }
          splitAndSave(parentRelationsObj, path.join(astManagerDir, 'parentRelations'))
          yasaLog(`[SAVE CACHE]Saved astManager parent relations (${parentRelations.size} relations)`)
        }
      }
      yasaLog('[SAVE CACHE]Saved astManager (parent relations recorded)')
    }

    // d. funcSymbolTable
    if (!Config.miniSaveContextEnvironment) {
      if (analyzer.funcSymbolTable) {
        // 重要：funcSymbolTable 是一个 Proxy，需要绕过 Proxy 直接访问原始对象（target）
        // 从 symbolTable 获取 funcSymbolTableTarget，这样可以直接获取 UUID 而不是符号值对象
        const { funcSymbolTableTarget } = analyzer.symbolTable as any
        if (funcSymbolTableTarget) {
          // 直接序列化原始对象，其中存储的是 UUID
          const funcSymbolTableData = serializeObject(funcSymbolTableTarget)
          splitAndSave(funcSymbolTableData, path.join(cacheBasePath, 'funcSymbolTable'), 1000, true)
          yasaLog('[SAVE CACHE]Saved funcSymbolTable')
        } else {
          // 如果没有 funcSymbolTableTarget，尝试直接序列化（可能不是 Proxy）
          const funcSymbolTableData = serializeObject(analyzer.funcSymbolTable)
          splitAndSave(funcSymbolTableData, path.join(cacheBasePath, 'funcSymbolTable'), 1000, true)
          yasaLog('[SAVE CACHE]Saved funcSymbolTable')
        }
      }
    }

    // e. statistics
    if (!Config.miniSaveContextEnvironment) {
      if (analyzer.statistics) {
        writeJSONfile(path.join(cacheBasePath, 'statistics.json'), analyzer.statistics)
        yasaLog('[SAVE CACHE]Saved statistics')
      }
    }

    // f. ainfo
    if (!Config.miniSaveContextEnvironment) {
      if (analyzer.ainfo) {
        // 在序列化前，记录 callgraph 是否为 Graph 实例
        const ainfoData = serializeObject(analyzer.ainfo)
        // 如果 callgraph 是 Graph 实例，记录其类型
        if (analyzer.ainfo.callgraph && analyzer.ainfo.callgraph.constructor?.name === 'GraphClass') {
          ainfoData.__yasaCallgraphIsGraph = true
        }
        splitAndSave(ainfoData, path.join(cacheBasePath, 'ainfo'), 1000, true)
        yasaLog('[SAVE CACHE]Saved ainfo')
      }
    }

    // g. sourceCodeCache
    if (!Config.miniSaveContextEnvironment) {
      if (analyzer.sourceCodeCache) {
        const sourceCodeCacheData = serializeObject(analyzer.sourceCodeCache)
        splitAndSave(sourceCodeCacheData, path.join(cacheBasePath, 'sourceCodeCache'), 1000, true)
        yasaLog('[SAVE CACHE]Saved sourceCodeCache')
      }
    }

    // h. classMap
    if (analyzer.classMap) {
      const classMapData = serializeObject(analyzer.classMap)
      splitAndSave(classMapData, path.join(cacheBasePath, 'classMap'), 1000, true)
      yasaLog('[SAVE CACHE]Saved classMap')
    }

    // 创建 topScope 文件夹
    const topScopeDir = path.join(cacheBasePath, 'topScope')
    if (!fs.existsSync(topScopeDir)) {
      fs.mkdirSync(topScopeDir, { recursive: true })
    }

    // i. topScope.context.modules (UUID for backward compatibility)
    const modulesUuid = analyzer.topScope.context?.modules?.uuid
    if (modulesUuid !== undefined) {
      writeJSONfile(path.join(topScopeDir, 'moduleManagerUuid.json'), {
        __moduleManagerUuid: modulesUuid,
      })
      yasaLog('[SAVE CACHE]Saved topScope.context.modules (moduleManagerUuid)')
    }

    // j. topScope.context.packages (UUID for backward compatibility)
    const packagesUuid = analyzer.topScope.context?.packages?.uuid
    if (packagesUuid !== undefined) {
      writeJSONfile(path.join(topScopeDir, 'packageManagerUuid.json'), {
        __packageManagerUuid: packagesUuid,
      })
      yasaLog('[SAVE CACHE]Saved topScope.context.packages (packageManagerUuid)')
    }

    // k. topScope.value（通过 getter 访问，EntityValue 返回 _members.getProxy()）
    const topScopeField = topScopeTarget.value
    if (topScopeField !== undefined) {
      const fieldData = serializeObject(topScopeField)
      writeJSONfile(path.join(topScopeDir, 'field.json'), { _field: fieldData })
      yasaLog('[SAVE CACHE]Saved topScope.value')
    }

    // l. topScope.uuid
    if (topScopeTarget.uuid !== undefined) {
      writeJSONfile(path.join(topScopeDir, 'uuid.json'), { uuid: topScopeTarget.uuid })
      yasaLog('[SAVE CACHE]Saved topScope.uuid')
    }

    // m. topScope 的其他所有属性
    // 获取 topScope 的所有属性，排除已经单独保存的属性
    const excludedProps = new Set([
      'context',
      '_field',
      'uuid',
      'funcSymbolTable',
      'symbolTable',
      'parent',
    ])
    const topScopeOtherProps: any = {}
    const topScopePropTypes: any = {} // 记录每个属性的类型
    const allTopScopeKeys = Reflect.ownKeys(topScopeTarget)
    for (const key of allTopScopeKeys) {
      if (typeof key === 'symbol') {
        continue
      }
      const keyStr = key as string
      // 跳过内部属性和已单独保存的属性
      if (keyStr.startsWith('__yasa')) {
        if (!names.includes(keyStr)) {
          names.push(keyStr)
        }
        continue
      }
      if (excludedProps.has(keyStr)) {
        continue
      }
      try {
        const value = Reflect.get(topScopeTarget, keyStr)
        // 记录属性类型
        if (value instanceof Map) {
          topScopePropTypes[keyStr] = 'Map'
        } else if (value instanceof Set) {
          topScopePropTypes[keyStr] = 'Set'
        } else if (Array.isArray(value)) {
          topScopePropTypes[keyStr] = 'Array'
        } else if (value && typeof value === 'object' && value.constructor?.name) {
          // 记录其他对象类型的构造函数名称
          topScopePropTypes[keyStr] = value.constructor.name
        }
        // 序列化属性值
        topScopeOtherProps[keyStr] = serializeObject(value)
      } catch (e) {
        yasaWarning(`Failed to serialize topScope property ${keyStr}: ${e}`)
      }
    }
    // 如果有其他属性，保存它们
    if (Object.keys(topScopeOtherProps).length > 0) {
      // 将类型信息添加到数据中
      topScopeOtherProps.__yasaPropTypes = topScopePropTypes
      splitAndSave(topScopeOtherProps, path.join(topScopeDir, 'otherProps'))
      yasaLog(`[SAVE CACHE]Saved topScope other properties (${Object.keys(topScopeOtherProps).length - 1} properties)`)
    }

    // 保存 checkerManager.registered_checkers 中每个 checker 的 sourceScope
    if (analyzer.checkerManager && analyzer.checkerManager.registered_checkers) {
      const checkerSourceScopes: any = {}
      for (const checkerName in analyzer.checkerManager.registered_checkers) {
        if (Object.prototype.hasOwnProperty.call(analyzer.checkerManager.registered_checkers, checkerName)) {
          const checker = analyzer.checkerManager.registered_checkers[checkerName]
          if (checker && checker.sourceScope) {
            // 序列化 sourceScope
            checkerSourceScopes[checkerName] = serializeObject(checker.sourceScope)
          }
        }
      }
      if (Object.keys(checkerSourceScopes).length > 0) {
        writeJSONfile(path.join(cacheBasePath, 'checkerSourceScopes.json'), checkerSourceScopes)
        yasaLog(`[SAVE CACHE]Saved checker sourceScopes (${Object.keys(checkerSourceScopes).length} checkers)`)
      }
    }

    // 保存缓存元数据
    const metadata = {
      cacheId: id,
      timestamp: new Date().toISOString(),
      version: '1.0',
    }
    writeJSONfile(path.join(cacheBasePath, 'metadata.json'), metadata)
    yasaLog(`[SAVE CACHE]Analyzer cache saved successfully to ${cacheBasePath}`)
  } catch (err: any) {
    yasaError(`[SAVE CACHE]Failed to save analyzer cache: ${err.message}`)
    throw err
  }
}

/**
 * 加载分析器缓存
 * @param analyzer 分析器实例
 * @param cacheId 缓存 ID
 * @param sourcePath
 * @returns 是否成功加载
 */
export function loadAnalyzerCache(analyzer: any, cacheId?: string, sourcePath?: string): boolean {
  try {
    const cacheDir = getCacheDir()
    let cacheFolder: string | null = null

    if (cacheId) {
      // 如果提供了 cacheId，直接使用
      cacheFolder = path.join(cacheDir, cacheId)
      if (!fs.existsSync(cacheFolder) || !fs.statSync(cacheFolder).isDirectory()) {
        yasaLog(`[LOAD CACHE]Cache folder not found at ${cacheFolder}`)
        cacheFolder = null
      }
    }

    // 如果 cacheId 未提供或未找到，且提供了 sourcePath，则根据 repoName 和 hashPrefix 查找
    if (!cacheFolder && sourcePath) {
      cacheFolder = findCacheFolder(sourcePath)
      if (cacheFolder) {
        yasaLog(`[LOAD CACHE]Found cache folder by sourcePath: ${cacheFolder}`)
      }
    }

    // 如果仍未找到，使用默认值
    if (!cacheFolder) {
      cacheFolder = path.join(cacheDir, 'default')
    }

    // 检查文件夹是否存在
    if (!fs.existsSync(cacheFolder) || !fs.statSync(cacheFolder).isDirectory()) {
      yasaLog(`[LOAD CACHE]Cache folder not found at ${cacheFolder}`)
      return false
    }

    const cacheBasePath = cacheFolder

    // 检查元数据文件是否存在
    const metadataPath = path.join(cacheBasePath, 'metadata.json')
    if (!fs.existsSync(metadataPath)) {
      yasaLog(`[LOAD CACHE]Cache metadata not found at ${metadataPath}`)
      return false
    }

    yasaLog(`[LOAD CACHE]Loading analyzer cache from ${cacheBasePath}...`)

    // 获取 topScope 的原始对象（绕过 Proxy）
    const topScopeTarget = (analyzer.topScope as any)[RAW_TARGET] || analyzer.topScope

    // a. fileManager
    const fileManagerData = loadFromSplit(path.join(cacheBasePath, 'fileManager'))
    if (fileManagerData) {
      analyzer.fileManager = fileManagerData
      yasaLog('[LOAD CACHE]Loaded fileManager')
    }

    // b. symbolTable
    // 检查是否存在子文件夹结构
    const symbolTableDir = path.join(cacheBasePath, 'symbolTable')
    let symbolTableData: any = null

    if (fs.existsSync(symbolTableDir) && fs.statSync(symbolTableDir).isDirectory()) {
      // 从子文件夹结构加载
      symbolTableData = {}
      const files = fs.readdirSync(symbolTableDir)
      for (const file of files) {
        // 跳过 info.json
        if (file === 'info.json') {
          continue
        }
        const filePath = path.join(symbolTableDir, file)
        const stat = fs.statSync(filePath)

        if (stat.isDirectory()) {
          // 是文件夹，说明是 Map 数据，使用 loadFromSplit 加载
          const propName = file
          const propData = loadFromSplit(filePath)
          if (propData !== null) {
            symbolTableData[propName] = propData
          }
        } else if (file.endsWith('.json')) {
          // 是 JSON 文件，直接加载
          const propName = file.replace(/\.json$/, '').replace(/\.part\d+$/, '')
          try {
            const propData = jsonfile.readFileSync(filePath)
            symbolTableData[propName] = propData
          } catch (err: any) {
            yasaWarning(`Failed to load symbolTable property ${propName}: ${err.message}`)
          }
        }
      }
    } else {
      // 使用原来的方式加载
      symbolTableData = loadFromSplit(path.join(cacheBasePath, 'symbolTable'))
    }

    if (symbolTableData && Object.keys(symbolTableData).length > 0) {
      // 反序列化 Map 和 Set，传递 topScope 引用以便恢复特殊标记
      const deserializedData = deserializeObject(symbolTableData, analyzer.topScope)
      // 需要恢复 symbolTable 的方法和状态
      // 先恢复 Map 类型的属性
      if (deserializedData.symbolMap instanceof Map) {
        const { symbolMap } = deserializedData
        // 遍历 symbolMap，将 topScope 特殊标记替换为实际引用
        // 同时确保所有 Unit 对象的属性都被正确恢复（包括 astNodehash）
        for (const [key, value] of symbolMap.entries()) {
          if (value && typeof value === 'object' && (value as any).__yasaTopScopeMarker === true) {
            symbolMap.set(key, analyzer.topScope)
          } else if (value && typeof value === 'object' && value.vtype) {
            // 这是一个 Unit 对象，确保所有属性都被正确恢复
            // deserializeObject 已经创建了新的对象，但我们需要确保所有属性都被正确赋值
            // 这里 value 已经是反序列化后的对象，应该包含所有属性（包括 astNodehash）
            // 不需要额外操作，因为 deserializeObject 已经处理了所有属性
          }
        }
        ;(analyzer.symbolTable as any).symbolMap = symbolMap
      }

      // 恢复其他属性
      for (const key in deserializedData) {
        if (key !== 'symbolMap' && Object.prototype.hasOwnProperty.call(deserializedData, key)) {
          ;(analyzer.symbolTable as any)[key] = deserializedData[key]
        }
      }
      yasaLog('[LOAD CACHE]Loaded symbolTable')
    }

    // c. astManager
    // 检查是否存在子文件夹结构
    const astManagerDir = path.join(cacheBasePath, 'astManager')
    let astManagerData: any = null

    if (fs.existsSync(astManagerDir) && fs.statSync(astManagerDir).isDirectory()) {
      // 从子文件夹结构加载
      astManagerData = {}
      const files = fs.readdirSync(astManagerDir)
      for (const file of files) {
        // 跳过 info.json
        if (file === 'info.json') {
          continue
        }
        const filePath = path.join(astManagerDir, file)
        const stat = fs.statSync(filePath)

        if (stat.isDirectory()) {
          // 是文件夹，说明是 Map 数据（如 astMap），使用 loadFromSplit 加载
          const propName = file
          const propData = loadFromSplit(filePath)
          if (propData !== null) {
            astManagerData[propName] = propData
          }
        } else if (file.endsWith('.json')) {
          // 是 JSON 文件，直接加载
          const propName = file.replace(/\.json$/, '').replace(/\.part\d+$/, '')
          try {
            const propData = jsonfile.readFileSync(filePath)
            astManagerData[propName] = propData
          } catch (err: any) {
            yasaWarning(`Failed to load astManager property ${propName}: ${err.message}`)
          }
        }
      }
    } else {
      // 使用原来的方式加载
      astManagerData = loadFromSplit(path.join(cacheBasePath, 'astManager'))
    }

    if (astManagerData) {
      // 先反序列化 astManagerData，将 astMap 从普通对象转换为 Map
      // 注意：在反序列化 AST 节点时跳过 parent 属性，后续统一设置
      const deserializedAstManager = deserializeObject(astManagerData, analyzer.topScope, true) // skipParentForAST = true
      Object.assign(analyzer.astManager, deserializedAstManager)

      const { astMap } = analyzer.astManager as any
      if (astMap instanceof Map) {
        // 第一步：替换所有子节点为 astMap 中的对象
        // 递归函数：替换节点及其所有子节点为 astMap 中的对象
        const replaceChildrenWithAstMapNodes = (node: any, visited: WeakSet<any> = new WeakSet()): void => {
          if (!node || typeof node !== 'object' || visited.has(node)) {
            return
          }
          visited.add(node)

          // 遍历节点的所有属性
          for (const key in node) {
            if (Object.prototype.hasOwnProperty.call(node, key)) {
              // 跳过 parent 属性（后续统一设置）
              if (key === 'parent') {
                continue
              }

              const value = node[key]

              // 如果是数组，递归处理每个元素
              if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                  const item = value[i]
                  if (item && typeof item === 'object' && item.type && item._meta?.nodehash) {
                    // 如果子节点有 nodehash，从 astMap 中获取对应的对象
                    const { nodehash } = item._meta
                    const astMapNode = astMap.get(nodehash)
                    if (astMapNode && astMapNode !== item) {
                      // 替换为 astMap 中的对象
                      value[i] = astMapNode
                      // 继续递归处理替换后的节点
                      replaceChildrenWithAstMapNodes(astMapNode, visited)
                    } else if (astMapNode === item) {
                      // 已经是同一个对象，继续递归处理
                      replaceChildrenWithAstMapNodes(item, visited)
                    } else {
                      // 不在 astMap 中，继续递归处理（可能是新节点）
                      replaceChildrenWithAstMapNodes(item, visited)
                    }
                  } else if (item && typeof item === 'object' && item.type) {
                    // 没有 nodehash，但可能是 AST 节点，继续递归处理
                    replaceChildrenWithAstMapNodes(item, visited)
                  }
                }
              } else if (value && typeof value === 'object' && value.type && value._meta?.nodehash) {
                // 如果子节点有 nodehash，从 astMap 中获取对应的对象
                const { nodehash } = value._meta
                const astMapNode = astMap.get(nodehash)
                if (astMapNode && astMapNode !== value) {
                  // 替换为 astMap 中的对象
                  node[key] = astMapNode
                  // 继续递归处理替换后的节点
                  replaceChildrenWithAstMapNodes(astMapNode, visited)
                } else if (astMapNode === value) {
                  // 已经是同一个对象，继续递归处理
                  replaceChildrenWithAstMapNodes(value, visited)
                } else {
                  // 不在 astMap 中，继续递归处理（可能是新节点）
                  replaceChildrenWithAstMapNodes(value, visited)
                }
              } else if (value && typeof value === 'object' && value.type) {
                // 没有 nodehash，但可能是 AST 节点，继续递归处理
                replaceChildrenWithAstMapNodes(value, visited)
              }
            }
          }
        }

        // 遍历所有节点，替换子节点为 astMap 中的对象
        for (const [nodehash, astNode] of astMap.entries()) {
          if (astNode && typeof astNode === 'object' && astNode.type) {
            replaceChildrenWithAstMapNodes(astNode)
          }
        }

        // 第二步：清理所有节点的 parent 引用
        const cleanupParent = (node: any, visited: WeakSet<any> = new WeakSet()): void => {
          if (!node || typeof node !== 'object' || visited.has(node)) {
            return
          }
          visited.add(node)

          // 如果节点有 parent，先删除它（后续统一设置）
          if (node.parent) {
            delete node.parent
          }

          // 递归处理所有属性（可能是数组或对象）
          for (const key in node) {
            if (Object.prototype.hasOwnProperty.call(node, key)) {
              const value = node[key]
              if (Array.isArray(value)) {
                for (const item of value) {
                  if (item && typeof item === 'object' && item.type) {
                    cleanupParent(item, visited)
                  }
                }
              } else if (value && typeof value === 'object' && value.type) {
                cleanupParent(value, visited)
              }
            }
          }
        }

        for (const [nodehash, astNode] of astMap.entries()) {
          if (astNode && typeof astNode === 'object' && astNode.type) {
            cleanupParent(astNode)
          }
        }

        // 第三步：根据 parentRelations 统一设置 parent
        const parentRelationsData = loadFromSplit(path.join(astManagerDir, 'parentRelations'))
        if (parentRelationsData) {
          let restoredCount = 0
          let missingNodeCount = 0
          let missingParentCount = 0
          for (const nodehash in parentRelationsData) {
            if (Object.prototype.hasOwnProperty.call(parentRelationsData, nodehash)) {
              const parentNodehash = parentRelationsData[nodehash]
              const astNode = astMap.get(nodehash)
              const parentNode = astMap.get(parentNodehash)
              if (!astNode) {
                missingNodeCount++
                // yasaWarning(`Node with nodehash ${nodehash} not found in astMap`)
                continue
              }
              if (!parentNode) {
                missingParentCount++
                continue
              }
              // 确保 parent 指向 astMap 中的对象
              astNode.parent = parentNode
              restoredCount++
            }
          }
          yasaLog(
            `[LOAD CACHE]Restored ${restoredCount} parent relations in astManager (missing nodes: ${missingNodeCount}, missing parents: ${missingParentCount})`
          )
        } else {
          yasaWarning('[LOAD CACHE]parentRelationsData not found')
        }
      } else {
        yasaWarning('[LOAD CACHE]astManager.astMap is not a Map instance')
      }

      yasaLog('[LOAD CACHE]Loaded astManager')
    }

    // d. funcSymbolTable
    const funcSymbolTableData = loadFromSplit(path.join(cacheBasePath, 'funcSymbolTable'))
    if (funcSymbolTableData) {
      // funcSymbolTable 的原始对象（target）
      const funcSymbolTableTarget = funcSymbolTableData
      // 重新创建 Proxy，自动处理 UUID 和对象的转换
      analyzer.funcSymbolTable = new Proxy(funcSymbolTableTarget, {
        get: (target, prop: string | symbol) => {
          // 如果访问的是 Symbol 属性（如 Symbol.iterator），直接返回
          if (typeof prop === 'symbol') {
            return (target as any)[prop]
          }
          // 如果访问的是对象自身的方法或属性（如 toString, valueOf 等），直接返回
          if (prop === 'toString' || prop === 'valueOf' || prop === 'constructor') {
            return (target as any)[prop]
          }
          const value = target[prop]
          // 如果是 UUID，从符号表中获取对象
          if (value && typeof value === 'string' && value.startsWith('symuuid_')) {
            const unit = analyzer.symbolTable.get(value)
            // 如果从符号表获取到了对象，返回对象；否则返回 null
            return unit || null
          }
          // 如果不是 UUID，直接返回原值（可能是 undefined、null 或其他值）
          return value
        },
        set: (target, prop: string, value: any) => {
          // 如果新值是符号值对象，转换为 UUID 存储
          if (value && typeof value === 'object' && value.vtype && value.qid) {
            const uuid = analyzer.symbolTable.register(value)
            target[prop] = uuid
            // 记录引用关系
            ;(analyzer.symbolTable as any).addFuncSymbolTableRef?.(uuid, prop)
          } else {
            target[prop] = value
          }
          return true
        },
        deleteProperty: (target, prop: string) => {
          delete target[prop]
          return true
        },
        ownKeys: (target) => {
          return Reflect.ownKeys(target)
        },
        has: (target, prop) => {
          return prop in target
        },
      }) as Record<string, any>
      yasaLog('[LOAD CACHE]Loaded funcSymbolTable (Proxy restored)')
    }

    // e. statistics
    const statisticsPath = path.join(cacheBasePath, 'statistics.json')
    if (fs.existsSync(statisticsPath)) {
      const statisticsData = jsonfile.readFileSync(statisticsPath)
      analyzer.statistics = statisticsData
      yasaLog('[LOAD CACHE]Loaded statistics')
    }

    // f. ainfo
    const ainfoData = loadFromSplit(path.join(cacheBasePath, 'ainfo'))
    if (ainfoData) {
      // 检查是否需要恢复 callgraph 为 Graph 实例
      if (ainfoData.__yasaCallgraphIsGraph && ainfoData.callgraph) {
        // 创建新的 Graph 实例
        const callgraph = new Graph()
        // 恢复 nodes Map
        if (ainfoData.callgraph.nodes && typeof ainfoData.callgraph.nodes === 'object') {
          const nodesMap = new Map()
          for (const key in ainfoData.callgraph.nodes) {
            if (Object.prototype.hasOwnProperty.call(ainfoData.callgraph.nodes, key)) {
              nodesMap.set(key, ainfoData.callgraph.nodes[key])
            }
          }
          callgraph.nodes = nodesMap
        }
        // 恢复 edges Map
        if (ainfoData.callgraph.edges && typeof ainfoData.callgraph.edges === 'object') {
          const edgesMap = new Map()
          for (const key in ainfoData.callgraph.edges) {
            if (Object.prototype.hasOwnProperty.call(ainfoData.callgraph.edges, key)) {
              edgesMap.set(key, ainfoData.callgraph.edges[key])
            }
          }
          callgraph.edges = edgesMap
        }
        // 将 callgraph 设置为 Graph 实例
        ainfoData.callgraph = callgraph
        // 删除标记
        delete ainfoData.__yasaCallgraphIsGraph
      }
      analyzer.ainfo = ainfoData
      yasaLog('[LOAD CACHE]Loaded ainfo (callgraph restored as Graph instance)')
    }

    // g. sourceCodeCache
    const sourceCodeCacheData = loadFromSplit(path.join(cacheBasePath, 'sourceCodeCache'))
    if (sourceCodeCacheData) {
      // 将反序列化的对象转换为 Map
      if (sourceCodeCacheData && typeof sourceCodeCacheData === 'object' && !Array.isArray(sourceCodeCacheData)) {
        const map = new Map<string, string>()
        for (const key in sourceCodeCacheData) {
          if (Object.prototype.hasOwnProperty.call(sourceCodeCacheData, key)) {
            const value = sourceCodeCacheData[key]
            // 确保值是字符串
            map.set(key, value)
          }
        }
        analyzer.sourceCodeCache = map
      } else {
        analyzer.sourceCodeCache = new Map<string, string>()
      }
      // 更新全局 analyzer 引用
      const SourceLine = require('./source-line')
      SourceLine.setGlobalAnalyzer(analyzer)
      yasaLog('[LOAD CACHE]Loaded sourceCodeCache')
    }

    // h. classMap
    const classMapData = loadFromSplit(path.join(cacheBasePath, 'classMap'))
    if (classMapData) {
      // 将反序列化的对象转换为 Map
      if (classMapData && typeof classMapData === 'object' && !Array.isArray(classMapData)) {
        const map = new Map<string, string>()
        for (const key in classMapData) {
          if (Object.prototype.hasOwnProperty.call(classMapData, key)) {
            const value = classMapData[key]
            map.set(key, value)
          }
        }
        analyzer.classMap = map
      } else {
        analyzer.classMap = new Map<string, string>()
      }
      yasaLog('[LOAD CACHE]Loaded classMap')
    }

    // i. topScope.context.modules (resolve UUID from symbolTable)
    const moduleManagerUuidPath = path.join(cacheBasePath, 'topScope', 'moduleManagerUuid.json')
    if (fs.existsSync(moduleManagerUuidPath)) {
      const moduleManagerUuidData = jsonfile.readFileSync(moduleManagerUuidPath)
      if (moduleManagerUuidData.__moduleManagerUuid !== undefined) {
        if (!analyzer.topScope.context) {
          analyzer.topScope.context = new AnalysisContext()
        }
        analyzer.topScope.context.modules = analyzer.symbolTable.get(moduleManagerUuidData.__moduleManagerUuid)
        yasaLog('[LOAD CACHE]Loaded topScope.context.modules')
      }
    }

    // j. topScope.context.packages (resolve UUID from symbolTable)
    const packageManagerUuidPath = path.join(cacheBasePath, 'topScope', 'packageManagerUuid.json')
    if (fs.existsSync(packageManagerUuidPath)) {
      const packageManagerUuidData = jsonfile.readFileSync(packageManagerUuidPath)
      if (packageManagerUuidData.__packageManagerUuid !== undefined) {
        if (!analyzer.topScope.context) {
          analyzer.topScope.context = new AnalysisContext()
        }
        analyzer.topScope.context.packages = analyzer.symbolTable.get(packageManagerUuidData.__packageManagerUuid)
        yasaLog('[LOAD CACHE]Loaded topScope.context.packages')
      }
    }

    // j. topScope.value（从缓存恢复，JSON key 为 _field 保持向后兼容）
    const fieldPath = path.join(cacheBasePath, 'topScope', 'field.json')
    if (fs.existsSync(fieldPath)) {
      const fieldData = jsonfile.readFileSync(fieldPath)
      if (fieldData._field !== undefined) {
        topScopeTarget.value = fieldData._field
        yasaLog('[LOAD CACHE]Loaded topScope.value')
      }
    }

    // k. topScope.uuid
    const uuidPath = path.join(cacheBasePath, 'topScope', 'uuid.json')
    if (fs.existsSync(uuidPath)) {
      const uuidData = jsonfile.readFileSync(uuidPath)
      if (uuidData.uuid !== undefined) {
        topScopeTarget.uuid = uuidData.uuid
        yasaLog('[LOAD CACHE]Loaded topScope.uuid')
      }
    }

    // l. topScope 的其他所有属性
    const topScopeOtherPropsData = loadFromSplit(path.join(cacheBasePath, 'topScope', 'otherProps'))
    if (topScopeOtherPropsData) {
      // 获取类型信息
      const propTypes = topScopeOtherPropsData.__yasaPropTypes || {}
      // 先根据类型信息还原 Map 和 Set，然后再反序列化其他嵌套对象
      const processedProps: any = {}
      for (const key in topScopeOtherPropsData) {
        if (Object.prototype.hasOwnProperty.call(topScopeOtherPropsData, key)) {
          // 跳过类型信息标记
          if (key === '__yasaPropTypes') {
            continue
          }
          const propType = propTypes[key]
          const value = topScopeOtherPropsData[key]

          // 根据类型信息还原对象类型（在反序列化之前）
          if (propType === 'Map') {
            // 将普通对象转换为 Map（包括空对象）
            const map = new Map()
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              for (const mapKey in value) {
                if (Object.prototype.hasOwnProperty.call(value, mapKey)) {
                  // 递归反序列化 Map 的值
                  map.set(mapKey, deserializeObject(value[mapKey], analyzer.topScope))
                }
              }
            }
            // 即使 value 是 null/undefined 或空对象，也创建空 Map
            processedProps[key] = map
          } else if (propType === 'Set') {
            // 将数组转换为 Set（包括空数组）
            const set = new Set()
            if (Array.isArray(value)) {
              for (const item of value) {
                // 递归反序列化 Set 的元素
                set.add(deserializeObject(item, analyzer.topScope))
              }
            }
            // 即使 value 是 null/undefined 或空数组，也创建空 Set
            processedProps[key] = set
          } else {
            // 对于其他类型，先反序列化，然后再处理特殊类型
            processedProps[key] = deserializeObject(value, analyzer.topScope)
          }
        }
      }

      // 现在处理其他对象类型的还原（需要在反序列化之后）
      for (const key in processedProps) {
        if (Object.prototype.hasOwnProperty.call(processedProps, key)) {
          try {
            const propType = propTypes[key]
            let value = processedProps[key]

            // 检查是否是 topScope 特殊标记
            if (value && typeof value === 'object' && value.__yasaTopScopeMarker === true) {
              value = analyzer.topScope
            }

            // 对于其他对象类型（非 Map、Set、Array），使用 shallowCopyValue 恢复
            if (
              propType &&
              propType !== 'Map' &&
              propType !== 'Set' &&
              propType !== 'Array' &&
              propType !== 'Object' &&
              value &&
              typeof value === 'object'
            ) {
              // 使用 shallowCopyValue 恢复
              const objWithConstructor = { ...value }
              Object.defineProperty(objWithConstructor, 'constructor', {
                value: { name: propType },
                writable: true,
                enumerable: false,
                configurable: true,
              })
              value = shallowCopyValue(objWithConstructor)
            }

            topScopeTarget[key] = value
          } catch (e) {
            yasaWarning(`Failed to restore topScope property ${key}: ${e}`)
          }
        }
      }
      const propCount = Object.keys(processedProps).length
      yasaLog(`[LOAD CACHE]Loaded topScope other properties (${propCount} properties)`)
    }

    // 更新 topScope 的引用（确保 topScope.context 与 analyzer 中的引用一致）
    if (analyzer.topScope) {
      if (!analyzer.topScope.context) {
        analyzer.topScope.context = new AnalysisContext()
      }
      analyzer.topScope.context.files = analyzer.fileManager
      analyzer.topScope.context.ast = analyzer.astManager
      analyzer.topScope.context.symbols = analyzer.symbolTable
      analyzer.topScope.context.funcs = analyzer.funcSymbolTable
      analyzer.context = analyzer.topScope.context
    }

    // 恢复 checkerManager.registered_checkers 中每个 checker 的 sourceScope
    if (analyzer.checkerManager && analyzer.checkerManager.registered_checkers) {
      const checkerSourceScopesPath = path.join(cacheBasePath, 'checkerSourceScopes.json')
      if (fs.existsSync(checkerSourceScopesPath)) {
        try {
          const checkerSourceScopes = jsonfile.readFileSync(checkerSourceScopesPath)
          let restoredCheckerCount = 0
          for (const checkerName in checkerSourceScopes) {
            if (Object.prototype.hasOwnProperty.call(checkerSourceScopes, checkerName)) {
              // 检查 analyzer.checkerManager.registered_checkers 中是否有相同的 checker
              if (Object.prototype.hasOwnProperty.call(analyzer.checkerManager.registered_checkers, checkerName)) {
                const checker = analyzer.checkerManager.registered_checkers[checkerName]
                if (checker) {
                  // 反序列化 sourceScope
                  const sourceScopeData = checkerSourceScopes[checkerName]
                  if (sourceScopeData) {
                    const restoredSourceScope = deserializeObject(sourceScopeData, analyzer.topScope)
                    // 覆盖 checker 的 sourceScope
                    checker.sourceScope = restoredSourceScope
                    restoredCheckerCount++
                  }
                }
              }
            }
          }
          if (restoredCheckerCount > 0) {
            yasaLog(`[LOAD CACHE]Restored sourceScope for ${restoredCheckerCount} checkers`)
          }
        } catch (err: any) {
          yasaWarning(`[LOAD CACHE]Failed to load checker sourceScopes: ${err.message}`)
        }
      }
    }

    // 恢复所有 Unit 对象的 Proxy 结构（_field, decls, overloaded）
    if (analyzer.symbolTable && (analyzer.symbolTable as any).symbolMap instanceof Map) {
      const { symbolMap } = analyzer.symbolTable as any
      for (const [uuid, unit] of symbolMap.entries()) {
        if (unit && typeof unit === 'object' && unit.vtype) {
          // 这是一个 Unit 对象，需要恢复其 Proxy
          try {
            // 在恢复 Proxy 之前，确保所有属性（包括 astNodehash）都已经被正确恢复
            // deserializeObject 应该已经恢复了所有属性，但我们需要确保它们没有被覆盖

            let fieldTarget = unit.value
            if (fieldTarget && util.types.isProxy(fieldTarget)) {
              fieldTarget = (fieldTarget as any)[RAW_TARGET] || fieldTarget
            }
            if (fieldTarget === undefined || fieldTarget === null || typeof fieldTarget !== 'object') {
              fieldTarget = {}
            }

            if (unit.vtype === 'union' && typeof unit._syncElements === 'function') {
              const arr = Array.isArray(fieldTarget) ? fieldTarget : Object.values(fieldTarget)
              unit._syncElements(arr)
            } else {
              unit.value = fieldTarget
            }
          } catch (e) {
            yasaWarning(`Failed to restore Proxy for Unit ${uuid}: ${e}`)
          }
        }
      }
    }

    yasaLog(`[LOAD CACHE]Analyzer cache loaded successfully from ${cacheBasePath}`)
    return true
  } catch (err: any) {
    yasaError(`[LOAD CACHE]Failed to load analyzer cache: ${err.message}`)
    return false
  }
}

/**
 * 生成缓存 ID（基于源路径、日期和 MD5 哈希）
 * @param sourcePath 源路径
 * @returns 缓存 ID，格式：代码库名字_日期_MD5哈希（前8位）
 */
export function generateCacheId(sourcePath: string): string {
  const crypto = require('crypto')

  // 从路径中提取代码库名字（路径的最后一部分）
  const normalizedPath = path.normalize(sourcePath)
  const pathParts = normalizedPath.split(path.sep).filter((part: string) => part.length > 0)
  const repoName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : 'default'
  // 清理代码库名字，移除特殊字符，只保留字母、数字、下划线和连字符
  const cleanRepoName = repoName.replace(/[^a-zA-Z0-9_-]/g, '_')

  // 获取当前日期（格式：YYYYMMDD）
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const dateStr = `${year}${month}${day}`

  // 使用源路径生成 MD5 哈希（保证幂等性）
  const hash = crypto.createHash('md5').update(sourcePath).digest('hex')
  const hashPrefix = hash.substring(0, 8) // 取前8位

  // 组合：代码库名字_MD5哈希前缀_日期
  return `${cleanRepoName}_${hashPrefix}_${dateStr}`
}

/**
 * 根据 repoName 和 hashPrefix 查找缓存文件夹
 * @param sourcePath 源路径
 * @returns 缓存文件夹路径，如果不存在则返回 null
 */
export function findCacheFolder(sourcePath: string): string | null {
  const crypto = require('crypto')

  // 从路径中提取代码库名字（路径的最后一部分）
  const normalizedPath = path.normalize(sourcePath)
  const pathParts = normalizedPath.split(path.sep).filter((part: string) => part.length > 0)
  const repoName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : 'default'
  // 清理代码库名字，移除特殊字符，只保留字母、数字、下划线和连字符
  const cleanRepoName = repoName.replace(/[^a-zA-Z0-9_-]/g, '_')

  // 使用源路径生成 MD5 哈希（保证幂等性）
  const hash = crypto.createHash('md5').update(sourcePath).digest('hex')
  const hashPrefix = hash.substring(0, 8) // 取前8位

  // 查找匹配的缓存文件夹：repoName_hashPrefix_*
  const cacheDir = getCacheDir()
  if (!fs.existsSync(cacheDir)) {
    return null
  }

  const prefix = `${cleanRepoName}_${hashPrefix}_`
  const files = fs.readdirSync(cacheDir)

  // 查找以 prefix 开头的文件夹
  for (const file of files) {
    if (file.startsWith(prefix)) {
      const folderPath = path.join(cacheDir, file)
      const stat = fs.statSync(folderPath)
      if (stat.isDirectory()) {
        // 检查是否有 metadata.json 文件
        const metadataPath = path.join(folderPath, 'metadata.json')
        if (fs.existsSync(metadataPath)) {
          return folderPath
        }
      }
    }
  }

  return null
}
