# AGENTS.md

## Cursor Cloud specific instructions

### Project overview
YASA-Engine is a standalone CLI static analysis tool (TypeScript/Node.js). No databases, Docker containers, or web servers are needed.

### Running the application
- Entry point: `npx tsx src/main.ts`
- Example: `npx tsx src/main.ts --sourcePath <dir-or-file> --language javascript --report <output-dir>`
- Supported languages: `javascript`, `typescript`, `java`, `golang`, `python`
- Use `--dumpAST` for single-file AST output, `--checkerIds` to specify checkers, `--ruleConfigFile` for custom rules

### Lint / Type-check / Test
- Lint: `npm run lint` (pre-existing warnings/errors exist in the codebase; exit code 2 is normal)
- Type-check: `npx tsc --noEmit`
- Tests: `npm run test-js`, `npm run test-java`, `npm run test-go`, `npm run test-python`, `npm run test-all`
- Tests require cloning benchmark repos from GitHub first via `npx mocha --require tsx/cjs test/<lang>/prepare-<lang>-benchmark.ts`

### Key caveats
- Go and Python analysis require native binaries at `deps/uast4go/uast4go` and `deps/uast4py/uast4py`. Run `bash install_deps.sh` to download them.
- Test benchmark data is cloned from `https://github.com/alipay/ant-application-security-testing-benchmark.git` into `test/<lang>/benchmarks/`. If the directory already exists, the prepare script deletes and re-clones it.
- The `package.json` has `"install": "npm install"` which is a no-op but won't cause issues.
- ESLint config references `tsconfig.json`; linting only covers `src/` (test files are in ignorePatterns).
