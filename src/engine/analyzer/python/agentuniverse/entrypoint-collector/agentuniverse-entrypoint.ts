const fs = require('fs')
const path = require('path')
const fg = require('fast-glob')
const { extractRelativePath } = require('../../../../../util/file-util')
const EntryPoint = require('../../../common/entrypoint/entrypoint')
const Constant = require('../../../../../util/constant')

const AU_DEPENDENCY_NAMES = ['agentuniverse', 'agentuniverse_ant_ext']
const AU_AGENT_BASE_NAMES = new Set(['AgentTemplate', 'BaseAgent'])
const AU_TOOL_BASE_NAMES = new Set(['Tool'])
const AU_AGENT_LIFECYCLE_METHODS = ['customized_execute', 'execute', 'parse_input']
const AU_TOOL_LIFECYCLE_METHODS = ['execute', 'parse_input']

type AuClassKind = 'agent' | 'tool'
type AstNodeType = 'VariableDeclaration' | 'ImportExpression' | 'ClassDefinition' | 'FunctionDefinition' | 'Identifier' | 'Literal' | 'MemberAccess'

interface AstLocPosition {
  line?: number
}

interface AstLoc {
  start?: AstLocPosition
  end?: AstLocPosition
}

interface AstIdentifier {
  type?: AstNodeType
  name?: string
  value?: string
}

interface AstImportExpression {
  type?: AstNodeType
  from?: AstIdentifier | null
  imported?: AstIdentifier | null
}

interface AstVariableDeclaration {
  type?: AstNodeType
  id?: AstIdentifier
  init?: AstImportExpression
}

interface AstFunctionDefinition {
  type?: AstNodeType
  id?: AstIdentifier
  loc?: AstLoc
}

interface AstClassDefinition {
  type?: AstNodeType
  id?: AstIdentifier
  supers?: AstExpression[]
  body?: AstNode[]
}

interface AstMemberAccess {
  type?: AstNodeType
  object?: AstExpression
  property?: AstExpression
}

type AstExpression = AstIdentifier | AstMemberAccess
type AstNode = AstVariableDeclaration | AstClassDefinition | AstFunctionDefinition | AstIdentifier | AstMemberAccess

interface PythonAstFile {
  body?: AstNode[]
}

function isVariableDeclaration(node: AstNode): node is AstVariableDeclaration {
  return node.type === 'VariableDeclaration'
}

function isClassDefinition(node: AstNode): node is AstClassDefinition {
  return node.type === 'ClassDefinition'
}

function isFunctionDefinition(node: AstNode): node is AstFunctionDefinition {
  return node.type === 'FunctionDefinition'
}

function isMemberAccess(node: AstExpression): node is AstMemberAccess {
  return node.type === 'MemberAccess'
}

interface ClassInfo {
  className: string
  moduleName: string
  filename: string
  node: AstClassDefinition
  bases: string[]
  auImportedBases: Set<string>
}

interface ConfigBinding {
  moduleName: string
  className: string
}

interface AuCollectorResult {
  agentUniverseEntryPointArray: unknown[]
  agentUniverseEntryPointSourceArray: unknown[]
}

interface MutableEntryPoint {
  filePath?: string
  functionName?: string
  attribute?: string
  framework?: string
  funcLocStart?: number
  funcLocEnd?: number
}

function normalizeModuleName(value: string): string {
  return value.replace(/^\.+/, '').replace(/^\/+/, '').replace(/\.py$/, '').replace(/[\\/]/g, '.')
}

function moduleNameFromFilename(filename: string, dir: string): string {
  const relative = extractRelativePath(filename, dir) || path.relative(dir, filename)
  const withoutExt = normalizeModuleName(relative.replace(/\.py$/, ''))
  return withoutExt.endsWith('.__init__') ? withoutExt.slice(0, -'.__init__'.length) : withoutExt
}

function extractLiteralString(node: AstIdentifier | null | undefined): string | null {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name
  return null
}

function extractImportedName(imported: AstIdentifier | null | undefined): string | null {
  if (!imported) return null
  if (imported.type === 'Identifier' && typeof imported.name === 'string') return imported.name
  if (imported.type === 'Literal' && typeof imported.value === 'string') return imported.value
  return null
}

function collectAuImportedBases(body: AstNode[]): Set<string> {
  const result = new Set<string>()
  for (const node of body) {
    if (!isVariableDeclaration(node) || node.init?.type !== 'ImportExpression') continue
    const fromValue = extractLiteralString(node.init.from)
    const importedName = extractImportedName(node.init.imported)
    const localName = node.id?.name
    if (!localName) continue
    if (!fromValue && importedName && AU_DEPENDENCY_NAMES.some((name) => importedName === name)) {
      result.add(localName)
      continue
    }
    if (fromValue && AU_DEPENDENCY_NAMES.some((name) => fromValue === name || fromValue.startsWith(`${name}.`))) {
      if (importedName === 'AgentTemplate' || importedName === 'BaseAgent' || importedName === 'Tool') {
        result.add(localName)
      }
      if ((fromValue.includes('agent_template') || fromValue.includes('base_agent') || fromValue.includes('action.tool.tool')) && importedName) {
        result.add(localName)
      }
    }
  }
  return result
}

function hasAuImport(body: AstNode[] | undefined): boolean {
  if (!Array.isArray(body)) return false
  for (const node of body) {
    if (!isVariableDeclaration(node) || node.init?.type !== 'ImportExpression') continue
    const fromValue = extractLiteralString(node.init.from)
    const importedName = extractImportedName(node.init.imported)
    if (!fromValue && importedName && AU_DEPENDENCY_NAMES.some((name) => importedName === name)) return true
    if (fromValue && AU_DEPENDENCY_NAMES.some((name) => fromValue === name || fromValue.startsWith(`${name}.`))) return true
  }
  return false
}

function getNameFromExpression(node: AstExpression | undefined): string | null {
  if (!node) return null
  if ('name' in node && typeof node.name === 'string') return node.name
  if ('value' in node && typeof node.value === 'string') return node.value
  if (isMemberAccess(node)) {
    const objectName = getNameFromExpression(node.object)
    const propertyName = getNameFromExpression(node.property)
    return objectName && propertyName ? `${objectName}.${propertyName}` : propertyName || objectName
  }
  return null
}

function collectClassInfo(filenameAstObj: Record<string, PythonAstFile>, dir: string): Map<string, ClassInfo> {
  const classIndex = new Map<string, ClassInfo>()
  for (const filename in filenameAstObj) {
    const body = filenameAstObj[filename]?.body
    if (!Array.isArray(body)) continue
    const moduleName = moduleNameFromFilename(filename, dir)
    const auImportedBases = collectAuImportedBases(body)
    for (const node of body) {
      if (!isClassDefinition(node) || !node.id?.name) continue
      const bases = Array.isArray(node.supers)
        ? node.supers.map((base: AstExpression) => getNameFromExpression(base)).filter((base: string | null): base is string => Boolean(base))
        : []
      classIndex.set(`${moduleName}.${node.id.name}`, {
        className: node.id.name,
        moduleName,
        filename,
        node,
        bases,
        auImportedBases,
      })
    }
  }
  return classIndex
}

function isDirectAuBase(info: ClassInfo, base: string, expectedBases: Set<string>): boolean {
  const shortBase = base.split('.').pop() || base
  if (info.auImportedBases.has(shortBase) && expectedBases.has(shortBase)) return true
  return base.includes('agentuniverse') && [...expectedBases].some((name) => base.endsWith(`.${name}`))
}

function findClassByName(classIndex: Map<string, ClassInfo>, moduleName: string, base: string): ClassInfo | undefined {
  const exact = classIndex.get(`${moduleName}.${base}`) || classIndex.get(base)
  if (exact) return exact
  const shortBase = base.split('.').pop() || base
  for (const candidate of classIndex.values()) {
    if (candidate.className === shortBase) return candidate
  }
  return undefined
}

function hasInheritedAuBase(
  info: ClassInfo,
  classIndex: Map<string, ClassInfo>,
  expectedBases: Set<string>,
  seen: Set<string> = new Set()
): boolean {
  const key = `${info.moduleName}.${info.className}`
  if (seen.has(key)) return false
  seen.add(key)
  for (const base of info.bases) {
    if (isDirectAuBase(info, base, expectedBases)) return true
    const parentClass = findClassByName(classIndex, info.moduleName, base)
    if (parentClass && hasInheritedAuBase(parentClass, classIndex, expectedBases, seen)) return true
  }
  return false
}

function classifyAuClass(info: ClassInfo, classIndex: Map<string, ClassInfo>): AuClassKind | null {
  if (hasInheritedAuBase(info, classIndex, AU_TOOL_BASE_NAMES)) return 'tool'
  if (hasInheritedAuBase(info, classIndex, AU_AGENT_BASE_NAMES)) return 'agent'
  return null
}

function findMethod(classNode: AstClassDefinition, methodName: string): AstFunctionDefinition | null {
  if (!Array.isArray(classNode.body)) return null
  for (const member of classNode.body) {
    if (isFunctionDefinition(member) && member.id?.name === methodName) return member
  }
  return null
}

function hasAuDependency(dir: string): boolean {
  const dependencyFiles = fg.sync(['**/requirements*.txt', '**/pyproject.toml', '**/setup.py', '**/setup.cfg', '**/Pipfile', '**/poetry.lock'], {
    cwd: dir,
    absolute: true,
    dot: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
  }) as string[]
  for (const file of dependencyFiles) {
    try {
      const content = fs.readFileSync(file, 'utf8').toLowerCase()
      if (AU_DEPENDENCY_NAMES.some((name) => content.includes(name.toLowerCase()))) return true
    } catch (_error) {
      // 读不到依赖文件时仅放弃该证据，避免阻断其它 AU 证据。
    }
  }
  return false
}

function parseJsonConfigBindings(content: string): ConfigBinding[] {
  try {
    return collectBindingsFromJsonValue(JSON.parse(content))
  } catch (_error) {
    return []
  }
}

function collectBindingsFromJsonValue(value: unknown): ConfigBinding[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item: unknown) => collectBindingsFromJsonValue(item))
  const record = value as Record<string, unknown>
  const bindings: ConfigBinding[] = []
  if (typeof record.module === 'string' && typeof record.class === 'string') {
    bindings.push({ moduleName: normalizeModuleName(record.module.trim()), className: record.class.trim() })
  }
  for (const nested of Object.values(record)) {
    bindings.push(...collectBindingsFromJsonValue(nested))
  }
  return bindings
}

function stripYamlScalar(value: string): string {
  return value.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
}

function parseYamlConfigBindings(content: string): ConfigBinding[] {
  const bindings: ConfigBinding[] = []
  let currentModule: string | undefined
  let currentClass: string | undefined
  const pushCurrent = (): void => {
    if (currentModule && currentClass) {
      bindings.push({ moduleName: normalizeModuleName(currentModule), className: currentClass })
      currentModule = undefined
      currentClass = undefined
    }
  }

  for (const line of content.split(/\r?\n/)) {
    const keyMatch = line.match(/^\s*-?\s*(module|class)\s*:\s*(.+?)\s*$/)
    if (!keyMatch) {
      if (/^\s*$/.test(line)) {
        pushCurrent()
        currentModule = undefined
        currentClass = undefined
      }
      continue
    }
    const key = keyMatch[1]
    const value = stripYamlScalar(keyMatch[2])
    if (key === 'module') {
      if (currentModule && currentClass) pushCurrent()
      currentModule = value
    } else {
      if (currentModule && currentClass) pushCurrent()
      currentClass = value
    }
  }
  pushCurrent()
  return bindings
}

function parseConfigBindings(content: string): ConfigBinding[] {
  const bindings = [...parseJsonConfigBindings(content), ...parseYamlConfigBindings(content)]
  const seen = new Set<string>()
  return bindings.filter((binding: ConfigBinding) => {
    const key = `${binding.moduleName}.${binding.className}`
    if (seen.has(key)) return false
    seen.add(key)
    return binding.moduleName.length > 0 && binding.className.length > 0
  })
}

function collectConfigBindings(dir: string): ConfigBinding[] {
  const configFiles = fg.sync(['**/*.yaml', '**/*.yml', '**/*.json'], {
    cwd: dir,
    absolute: true,
    dot: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/package-lock.json'],
  }) as string[]
  const bindings: ConfigBinding[] = []
  for (const file of configFiles) {
    try {
      bindings.push(...parseConfigBindings(fs.readFileSync(file, 'utf8')))
    } catch (_error) {
      // 配置解析仅作为入口证据，失败时不影响 Python AST 入口收集。
    }
  }
  return bindings
}

function createEntryPoint(filename: string, dir: string, functionName: string, methodNode: AstFunctionDefinition): unknown {
  const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL) as MutableEntryPoint
  entryPoint.filePath = extractRelativePath(filename, dir)
  entryPoint.functionName = functionName
  entryPoint.attribute = 'AgentUniverse'
  entryPoint.framework = 'agentuniverse'
  entryPoint.funcLocStart = methodNode.loc?.start?.line
  entryPoint.funcLocEnd = methodNode.loc?.end?.line
  return entryPoint
}

function findAgentUniverseEntryPointAndSource(filenameAstObj: Record<string, PythonAstFile>, dir: string): AuCollectorResult {
  const agentUniverseEntryPointArray: unknown[] = []
  const agentUniverseEntryPointSourceArray: unknown[] = []
  const classIndex = collectClassInfo(filenameAstObj, dir)
  const hasImportEvidence = Object.values(filenameAstObj).some((ast: PythonAstFile) => hasAuImport(ast.body))
  const hasDependencyEvidence = hasAuDependency(dir)
  const classKinds = new Map<string, AuClassKind>()

  for (const [key, info] of classIndex.entries()) {
    const classKind = classifyAuClass(info, classIndex)
    if (classKind) classKinds.set(key, classKind)
  }

  if (!hasDependencyEvidence && !hasImportEvidence && classKinds.size === 0) {
    return { agentUniverseEntryPointArray, agentUniverseEntryPointSourceArray }
  }

  const seen = new Set<string>()
  for (const binding of collectConfigBindings(dir)) {
    const classKey = `${binding.moduleName}.${binding.className}`
    const info = classIndex.get(classKey)
    const classKind = classKinds.get(classKey)
    if (!info || !classKind) continue
    const lifecycleMethods = classKind === 'tool' ? AU_TOOL_LIFECYCLE_METHODS : AU_AGENT_LIFECYCLE_METHODS
    for (const methodName of lifecycleMethods) {
      const methodNode = findMethod(info.node, methodName)
      if (!methodNode) continue
      const entryKey = `${info.filename}:${methodName}:${methodNode.loc?.start?.line || 0}`
      if (seen.has(entryKey)) continue
      seen.add(entryKey)
      agentUniverseEntryPointArray.push(createEntryPoint(info.filename, dir, methodName, methodNode))
    }
  }

  return { agentUniverseEntryPointArray, agentUniverseEntryPointSourceArray }
}

export = {
  findAgentUniverseEntryPointAndSource,
  parseConfigBindings,
}
