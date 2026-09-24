-- 函数 mapper 按稳定查询语义划分，而不是为 exact/suffix/regex 复制相同 SELECT。
-- 所有模板参数均先绑定 function、method，再绑定 query layer 编译出的 condition params。

-- name: function_search
-- 符号搜索按限定名、文件和源码位置稳定排序；完整 FQCN 等值路径可使用 qualified_name 索引。
SELECT id, kind, name, qualified_name, signature, return_type, file_path, start_line, start_column, end_line, end_column
FROM nodes
WHERE kind IN (?, ?) AND {conditions}
ORDER BY qualified_name, file_path, start_line

-- name: functions_by_file
-- 文件查询按源码顺序返回；all/exact/regex 共享模板，仅条件扫描成本不同。
SELECT id, kind, name, qualified_name, signature, return_type, file_path, start_line, start_column, end_line, end_column
FROM nodes
WHERE kind IN (?, ?) AND {conditions}
ORDER BY file_path, start_line, start_column

-- name: methods_by_owner
-- owner 前缀只能表达类型成员；限定 kind='method'，避免把同前缀自由 function 误映射为方法。
SELECT id, kind, name, qualified_name, signature, return_type, file_path, start_line, start_column, end_line, end_column
FROM nodes
WHERE kind = ? AND {conditions}
ORDER BY start_line, start_column

-- name: enclosing_function
-- 包围函数按最小 span 优先，以便嵌套函数场景选择最贴近目标代码的位置。
SELECT id, kind, name, qualified_name, signature, return_type, file_path, start_line, start_column, end_line, end_column
FROM nodes
WHERE kind IN (?, ?) AND {conditions}
ORDER BY (end_line - start_line) ASC, start_line DESC, start_column DESC
