import fs from 'fs'
import path from 'path'

const DEFAULT_IGNORED_DIRS = new Set(['.git', 'node_modules', 'deps', 'dist', 'build', '.venv', 'venv', '__pycache__'])
const DEFAULT_SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.go',
  '.py',
  '.java',
  '.php',
  '.vue',
])

export function collectProjectSourceFiles(rootDir: string): Map<string, string> {
  const files = new Map<string, string>()
  collectSourceFiles(rootDir, files)
  return files
}

function collectSourceFiles(currentPath: string, files: Map<string, string>): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(currentPath)
  } catch (_err) {
    return
  }
  if (stat.isFile()) {
    collectSourceFile(currentPath, files)
    return
  }
  if (!stat.isDirectory()) return
  const baseName = path.basename(currentPath)
  if (DEFAULT_IGNORED_DIRS.has(baseName)) return
  let children: string[]
  try {
    children = fs.readdirSync(currentPath)
  } catch (_err) {
    return
  }
  for (const child of children) collectSourceFiles(path.join(currentPath, child), files)
}

function collectSourceFile(filePath: string, files: Map<string, string>): void {
  if (!DEFAULT_SOURCE_EXTENSIONS.has(path.extname(filePath))) return
  try {
    files.set(filePath, fs.readFileSync(filePath, 'utf8'))
  } catch (_err) {
    return
  }
}
