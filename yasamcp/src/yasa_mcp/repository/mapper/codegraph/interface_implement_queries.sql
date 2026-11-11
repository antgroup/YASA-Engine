-- AuthScan 接口实现查询采用方案 C，固定数据流为：
--   interface node -> implements edge -> implementation class -> implementation method。
--
-- CodeGraph 的 implements edge 方向固定为：source=实现类，target=接口。因此第一次 JOIN
-- 从接口节点沿 impl.target 找到 implements edge，第二次 JOIN 再通过 impl.source 定位实现类。
-- 第三次 JOIN 关联实现方法：method 模板按“实现类 FQN::方法名”精确查询，interface-only
-- 模板才按“实现类 FQN::”前缀查询该实现类的方法候选。四个模板禁止混用。
--
-- 四个模板均固定为 3 次 JOIN，不 JOIN 接口方法及 contains edge，不沿 extends/继承链扩展。
-- 实现方法使用 LEFT JOIN：实现类存在但目标方法不存在时仍保留关系行，供 processor 标记
-- gap_class。所有外部输入均通过参数绑定传入，不拼接用户提供的 SQL 片段。

-- name: interface_implement_by_fqcn
-- 输入：接口全限定名 + 方法名。与 short-name method 模板仅接口过滤字段不同。
SELECT
    i.id AS interface_id,
    i.name AS interface_name,
    i.qualified_name AS interface_qualified_name,
    c.id AS implementation_class_id,
    c.name AS implementation_class_name,
    c.qualified_name AS implementation_class_qualified_name,
    m.id AS implementation_method_id,
    m.name AS implementation_method_name,
    m.qualified_name AS implementation_method_qualified_name,
    m.signature,
    m.return_type,
    m.language,
    m.file_path,
    m.start_line,
    m.start_column,
    m.end_line,
    m.end_column,
    c.file_path AS implementation_class_file_path,
    c.start_line AS implementation_class_start_line,
    c.start_column AS implementation_class_start_column,
    c.end_line AS implementation_class_end_line,
    c.end_column AS implementation_class_end_column,
    c.language AS implementation_class_language,
    impl.metadata AS implements_metadata,
    impl.provenance AS implements_provenance
-- 步骤 1：以 interface 节点为查询起点，WHERE 最终按接口 FQCN 精确过滤。
FROM nodes i
-- 步骤 2：impl.target 指向接口；只保留 kind='implements' 的实现关系。
JOIN edges impl
  ON impl.target = i.id
 AND impl.kind = 'implements'
-- 步骤 3：impl.source 指向实现类；通过主键定位 class 节点。
JOIN nodes c
  ON c.id = impl.source
 AND c.kind = 'class'
-- 步骤 4：按“实现类 FQN::方法名”精确关联 method；无方法时保留实现类关系行。
LEFT JOIN nodes m
  ON m.kind = 'method'
 AND m.qualified_name = c.qualified_name || '::' || ?
 AND m.language = ?
WHERE i.kind = 'interface'
  AND i.language = ?
  AND c.language = ?
  AND i.qualified_name = ?
ORDER BY c.qualified_name, m.start_line, m.start_column, m.id

-- name: interface_implement_by_short_name
-- 输入：接口短名 + 方法名。主体与 FQCN method 模板相同，仅接口按 i.name 过滤。
SELECT
    i.id AS interface_id,
    i.name AS interface_name,
    i.qualified_name AS interface_qualified_name,
    c.id AS implementation_class_id,
    c.name AS implementation_class_name,
    c.qualified_name AS implementation_class_qualified_name,
    m.id AS implementation_method_id,
    m.name AS implementation_method_name,
    m.qualified_name AS implementation_method_qualified_name,
    m.signature,
    m.return_type,
    m.language,
    m.file_path,
    m.start_line,
    m.start_column,
    m.end_line,
    m.end_column,
    c.file_path AS implementation_class_file_path,
    c.start_line AS implementation_class_start_line,
    c.start_column AS implementation_class_start_column,
    c.end_line AS implementation_class_end_line,
    c.end_column AS implementation_class_end_column,
    c.language AS implementation_class_language,
    impl.metadata AS implements_metadata,
    impl.provenance AS implements_provenance
-- 步骤 1：以 interface 节点为查询起点，WHERE 最终按接口短名精确过滤。
FROM nodes i
-- 步骤 2：impl.target 指向接口；只保留 kind='implements' 的实现关系。
JOIN edges impl
  ON impl.target = i.id
 AND impl.kind = 'implements'
-- 步骤 3：impl.source 指向实现类；通过主键定位 class 节点。
JOIN nodes c
  ON c.id = impl.source
 AND c.kind = 'class'
-- 步骤 4：按“实现类 FQN::方法名”精确关联 method；无方法时保留实现类关系行。
LEFT JOIN nodes m
  ON m.kind = 'method'
 AND m.qualified_name = c.qualified_name || '::' || ?
 AND m.language = ?
WHERE i.kind = 'interface'
  AND i.language = ?
  AND c.language = ?
  AND i.name = ?
ORDER BY i.qualified_name, c.qualified_name, m.start_line, m.start_column, m.id

-- name: interface_only_implement_by_fqcn
-- 输入：仅接口全限定名。与 short-name interface-only 模板仅接口过滤字段不同。
SELECT
    i.id AS interface_id,
    i.name AS interface_name,
    i.qualified_name AS interface_qualified_name,
    c.id AS implementation_class_id,
    c.name AS implementation_class_name,
    c.qualified_name AS implementation_class_qualified_name,
    m.id AS implementation_method_id,
    m.name AS implementation_method_name,
    m.qualified_name AS implementation_method_qualified_name,
    m.signature,
    m.return_type,
    m.language,
    m.file_path,
    m.start_line,
    m.start_column,
    m.end_line,
    m.end_column,
    c.file_path AS implementation_class_file_path,
    c.start_line AS implementation_class_start_line,
    c.start_column AS implementation_class_start_column,
    c.end_line AS implementation_class_end_line,
    c.end_column AS implementation_class_end_column,
    c.language AS implementation_class_language,
    impl.metadata AS implements_metadata,
    impl.provenance AS implements_provenance
-- 步骤 1：以 interface 节点为查询起点，WHERE 最终按接口 FQCN 精确过滤。
FROM nodes i
-- 步骤 2：impl.target 指向接口；只保留 kind='implements' 的实现关系。
JOIN edges impl
  ON impl.target = i.id
 AND impl.kind = 'implements'
-- 步骤 3：impl.source 指向实现类；通过主键定位 class 节点。
JOIN nodes c
  ON c.id = impl.source
 AND c.kind = 'class'
-- 步骤 4：按“实现类 FQN::”前缀关联该实现类的方法候选；无方法时保留关系行。
LEFT JOIN nodes m
  ON m.kind = 'method'
 AND m.qualified_name LIKE c.qualified_name || '::%'
 AND m.language = ?
WHERE i.kind = 'interface'
  AND i.language = ?
  AND c.language = ?
  AND i.qualified_name = ?
ORDER BY c.qualified_name, m.start_line, m.start_column, m.id

-- name: interface_only_implement_by_short_name
-- 输入：仅接口短名。主体与 FQCN interface-only 模板相同，仅接口按 i.name 过滤。
SELECT
    i.id AS interface_id,
    i.name AS interface_name,
    i.qualified_name AS interface_qualified_name,
    c.id AS implementation_class_id,
    c.name AS implementation_class_name,
    c.qualified_name AS implementation_class_qualified_name,
    m.id AS implementation_method_id,
    m.name AS implementation_method_name,
    m.qualified_name AS implementation_method_qualified_name,
    m.signature,
    m.return_type,
    m.language,
    m.file_path,
    m.start_line,
    m.start_column,
    m.end_line,
    m.end_column,
    c.file_path AS implementation_class_file_path,
    c.start_line AS implementation_class_start_line,
    c.start_column AS implementation_class_start_column,
    c.end_line AS implementation_class_end_line,
    c.end_column AS implementation_class_end_column,
    c.language AS implementation_class_language,
    impl.metadata AS implements_metadata,
    impl.provenance AS implements_provenance
-- 步骤 1：以 interface 节点为查询起点，WHERE 最终按接口短名精确过滤。
FROM nodes i
-- 步骤 2：impl.target 指向接口；只保留 kind='implements' 的实现关系。
JOIN edges impl
  ON impl.target = i.id
 AND impl.kind = 'implements'
-- 步骤 3：impl.source 指向实现类；通过主键定位 class 节点。
JOIN nodes c
  ON c.id = impl.source
 AND c.kind = 'class'
-- 步骤 4：按“实现类 FQN::”前缀关联该实现类的方法候选；无方法时保留关系行。
LEFT JOIN nodes m
  ON m.kind = 'method'
 AND m.qualified_name LIKE c.qualified_name || '::%'
 AND m.language = ?
WHERE i.kind = 'interface'
  AND i.language = ?
  AND c.language = ?
  AND i.name = ?
ORDER BY i.qualified_name, c.qualified_name, m.start_line, m.start_column, m.id
