-- CodeGraph import 查询只消费 nodes.kind='import' 的原始索引事实。
-- 当前接口只回答“指定文件包含哪些导入”，因此不关联 edges，也不推导目标文件。
-- file_path、后缀匹配 pattern 和 limit 均由 repository 使用参数绑定传入。

-- name: import_nodes_by_file
SELECT id, name, qualified_name, file_path, start_line
FROM nodes
WHERE kind = 'import'
  AND file_path = ?
ORDER BY start_line, id
LIMIT ?

-- name: import_nodes_by_file_suffix
SELECT id, name, qualified_name, file_path, start_line
FROM nodes
WHERE kind = 'import'
  AND (file_path = ? OR file_path LIKE ? ESCAPE '\')
ORDER BY file_path, start_line, id
LIMIT ?
