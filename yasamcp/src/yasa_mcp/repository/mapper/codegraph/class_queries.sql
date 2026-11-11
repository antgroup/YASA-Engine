-- 类型搜索模板族：projection、class-like 范围和稳定排序恒定，只有受控 conditions 可替换。
-- 参数顺序为六种 kind、condition params；完整 FQN/name 等值条件可使用对应索引。
-- name: class_search
SELECT id, kind, name, qualified_name, signature, return_type, file_path, start_line, start_column, end_line, end_column
FROM nodes
WHERE kind IN (?, ?, ?, ?, ?, ?) AND {conditions}
ORDER BY qualified_name, start_line