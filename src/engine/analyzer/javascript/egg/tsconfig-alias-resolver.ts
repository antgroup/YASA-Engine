import * as path from 'path'
import * as fs from 'fs'
import * as ts from 'typescript'

type ModuleIndex = {
  get(key: string): unknown
}
type PathMapping = {
  pattern: string
  targets: readonly string[]
  order: number
}

const MODULE_SUFFIXES = ['', '.ts', '.js', '.mjs', '.cjs']
type CompilerOptionsWithPathsBasePath = ts.CompilerOptions & { pathsBasePath?: string }

/**
 * TypeScript 配置驱动的项目内模块别名解析器。
 */
export class TypeScriptAliasResolver {
  private constructor(
    private readonly projectRoot: string,
    private readonly baseUrl: string | undefined,
    private readonly pathsBasePath: string,
    private readonly pathMappings: readonly PathMapping[]
  ) {}

  static load(projectRoot: string): TypeScriptAliasResolver | undefined {
    const resolvedProjectRoot = path.resolve(projectRoot)
    const configPath = ['tsconfig.json', 'jsconfig.json']
      .map((name) => path.join(resolvedProjectRoot, name))
      .find((candidate) => ts.sys.fileExists(candidate))
    if (!configPath) return undefined

    const configHost: ts.ParseConfigFileHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      getCurrentDirectory: () => resolvedProjectRoot,
      fileExists: (candidate) => this.isWithinProject(resolvedProjectRoot, candidate) && ts.sys.fileExists(candidate),
      readFile: (candidate) => (this.isWithinProject(resolvedProjectRoot, candidate) ? ts.sys.readFile(candidate) : undefined),
      readDirectory: (candidate, extensions, excludes, includes, depth) =>
        this.isWithinProject(resolvedProjectRoot, candidate)
          ? ts.sys
              .readDirectory(candidate, extensions, excludes, includes, depth)
              .filter((file) => this.isWithinProject(resolvedProjectRoot, file))
          : [],
      onUnRecoverableConfigFileDiagnostic: () => undefined,
      trace: () => undefined,
    }
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, configHost)
    if (!parsed) return undefined

    const options = parsed.options as CompilerOptionsWithPathsBasePath
    const baseUrl = options.baseUrl
    if (baseUrl && !this.isWithinProject(resolvedProjectRoot, baseUrl)) return undefined
    const safeBaseUrl = baseUrl
    const pathsBasePath = options.pathsBasePath || safeBaseUrl || resolvedProjectRoot
    if (!this.isWithinProject(resolvedProjectRoot, pathsBasePath)) return undefined
    const pathMappings = TypeScriptAliasResolver.readPathMappings(options.paths)
    if (!safeBaseUrl && pathMappings.length === 0) return undefined

    return new TypeScriptAliasResolver(resolvedProjectRoot, safeBaseUrl, pathsBasePath, pathMappings)
  }

  resolveScannedModulePath(specifier: unknown, modules: ModuleIndex): string | undefined {
    if (typeof specifier !== 'string' || !this.isBareSpecifier(specifier)) return undefined

    for (const candidate of this.resolveCandidates(specifier)) {
      const module = modules.get(candidate)
      if (module !== undefined) return candidate
    }
    return undefined
  }

  private resolveCandidates(specifier: string): string[] {
    const targetPaths = this.resolvePathMappings(specifier)
    if (targetPaths.length === 0 && this.baseUrl) {
      targetPaths.push(path.resolve(this.baseUrl, specifier))
    }

    const candidates = new Set<string>()
    for (const targetPath of targetPaths) {
      if (!TypeScriptAliasResolver.isWithinProject(this.projectRoot, targetPath)) continue
      for (const suffix of MODULE_SUFFIXES) {
        const candidate = `${targetPath}${suffix}`
        if (TypeScriptAliasResolver.isWithinProject(this.projectRoot, candidate)) candidates.add(candidate)
      }
      for (const suffix of MODULE_SUFFIXES.slice(1)) {
        const candidate = path.join(targetPath, `index${suffix}`)
        if (TypeScriptAliasResolver.isWithinProject(this.projectRoot, candidate)) candidates.add(candidate)
      }
    }
    return Array.from(candidates)
  }

  private resolvePathMappings(specifier: string): string[] {
    const matchedMappings = this.pathMappings
      .map((mapping) => ({ mapping, match: this.matchPattern(mapping.pattern, specifier) }))
      .filter((item): item is { mapping: PathMapping; match: string } => item.match !== undefined)
      .sort((left, right) => {
        const specificity = right.mapping.pattern.length - left.mapping.pattern.length
        return specificity === 0 ? left.mapping.order - right.mapping.order : specificity
      })
    if (matchedMappings.length === 0) return []

    const { mapping, match } = matchedMappings[0]
    return mapping.targets.map((target) => path.resolve(this.pathsBasePath, target.replace('*', match)))
  }

  private static readPathMappings(paths: ts.MapLike<string[]> | undefined): PathMapping[] {
    if (!paths) return []
    const mappings: PathMapping[] = []
    let order = 0
    for (const [pattern, targets] of Object.entries(paths)) {
      if (!TypeScriptAliasResolver.isValidPathMapping(pattern, targets)) continue
      mappings.push({ pattern, targets, order })
      order++
    }
    return mappings
  }

  private static isValidPathMapping(pattern: string, targets: readonly string[]): boolean {
    const wildcardCount = (pattern.match(/\*/g) || []).length
    if (wildcardCount > 1 || !Array.isArray(targets) || targets.length === 0) return false
    return targets.every((target) => typeof target === 'string' && (target.match(/\*/g) || []).length === wildcardCount)
  }

  private matchPattern(pattern: string, specifier: string): string | undefined {
    const wildcardIndex = pattern.indexOf('*')
    if (wildcardIndex === -1) return pattern === specifier ? '' : undefined
    const prefix = pattern.slice(0, wildcardIndex)
    const suffix = pattern.slice(wildcardIndex + 1)
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined
    return specifier.slice(prefix.length, specifier.length - suffix.length)
  }

  private isBareSpecifier(specifier: string): boolean {
    return !specifier.startsWith('.') && !path.isAbsolute(specifier)
  }

  private static isWithinProject(projectRoot: string, candidate: string): boolean {
    const resolvedProjectRoot = path.resolve(projectRoot)
    const resolvedCandidate = path.resolve(candidate)
    const relative = path.relative(resolvedProjectRoot, resolvedCandidate)
    // COSEC: 配置与别名候选只允许位于项目根内，避免 paths/extends 触发越界读取。
    if (!(relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))) {
      return false
    }
    if (!fs.existsSync(resolvedCandidate)) return true

    try {
      const realProjectRoot = fs.realpathSync(resolvedProjectRoot)
      const realCandidate = fs.realpathSync(resolvedCandidate)
      const realRelative = path.relative(realProjectRoot, realCandidate)
      // COSEC: 已存在路径必须再按真实路径校验，拒绝项目目录中的符号链接逃逸。
      return realRelative === '' || (!realRelative.startsWith(`..${path.sep}`) && realRelative !== '..' && !path.isAbsolute(realRelative))
    } catch {
      return false
    }
  }
}
