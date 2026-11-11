-- Symbol search deliberately uses the CodeGraph external-content FTS index.
-- FTS recall deliberately does not restrict node kind.  The service interprets the
-- public kind after recall so new CodeGraph kinds are not silently excluded.
-- name: search_symbol_nodes
SELECT
    n.id,
    n.kind,
    n.name,
    n.qualified_name,
    n.file_path,
    n.language,
    n.start_line,
    n.start_column,
    n.end_line,
    n.end_column,
    n.signature,
    bm25(nodes_fts, 0, 20, 5, 1, 2) AS score
FROM nodes_fts
JOIN nodes n ON nodes_fts.id = n.id
WHERE {conditions}
ORDER BY score, n.kind, n.language, n.file_path,
         n.start_line, n.start_column, n.qualified_name, n.id
