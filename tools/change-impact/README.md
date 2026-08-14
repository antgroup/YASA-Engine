# Change Impact Lookup

`impact-lookup.ts` is the TypeScript entrypoint for DB-backed change impact lookup. It reads an existing `dataflow.db` and a list of changed ranges, then prints impacted entrypoints and evidence stats.

## CLI

```bash
npx tsx tools/change-impact/impact-lookup.ts \
  --db /path/to/dataflow.db \
  --changes '[{"file":"src/example.ts","startLine":1,"endLine":3}]'
```

## Test

```bash
npx mocha --require tsx/cjs tools/change-impact/impact-lookup.test.ts
```

The test builds a minimal SQLite fixture in a temporary directory. Historical replay scripts and generated result snapshots are task artifacts, not part of the published CLI surface.
