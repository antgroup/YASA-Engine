import re


def normalize_signature(java_decl: str) -> str:
    """
    规范化Java方法签名，返回格式为: methodName(Type1, Type2, ...)
    例如：
    输入: "public void updateUser(User<Profile > user, int id)"
    输出: "updateUser(User<Profile>, int)"
    """
    if not java_decl:
        return ""
    
    try:
        method_name, param_types = extract_java_signature(java_decl)
        # 清理参数类型中的空格，但保留类型结构
        cleaned_types = []
        for p in param_types:
            # 移除所有空白字符，确保 User<Profile > 变成 User<Profile>
            cleaned_types.append("".join(p.split()))
            
        return f"{method_name}({', '.join(cleaned_types)})"
    except Exception:
        # 如果解析失败，返回原始字符串（去除两端空白），不做更复杂的处理
        return java_decl.strip()


def extract_java_signature(java_decl: str) -> tuple[str, list[str]]:
    java_decl = java_decl.strip()
    # 用正则找到方法名和参数部分
    # 匹配：最后一个单词+左括号；参数内容为括号内（支持泛型逗号）
    method_match = re.search(r'(\w+)\s*\((.*)\)', java_decl)
    if not method_match:
        # 没有括号时，只提取最后一个word
        method_name = re.findall(r'\b\w+\b', java_decl)[-1]
        return method_name,[]  # 如果不是方法声明（例如构造函数无括号），可以特殊处理
    method_name = method_match.group(1)
    params_raw = method_match.group(2).strip()
    if not params_raw:
        return method_name, []
    # 拆分参数
    param_types = []
    bracket = 0  # 用于处理泛型里的逗号
    cur = ''
    for c in params_raw + ',':  # 最后补逗号保证结尾处理
        if c == '<':
            bracket += 1
            cur += c
        elif c == '>':
            bracket -= 1
            cur += c
        elif c == ',' and bracket == 0:
            if cur.strip():
                # 提取类型（第一个词到空格或第一个 '<'/'['）
                cur2 = cur.strip()
                type_match = re.match(r'(\S+(?:<[^>]+>)?(?:$$$$)*)', cur2)
                if type_match:
                    param_types.append(type_match.group(1))
                else:
                    # 兜底只取第一个词
                    param_types.append(cur2.split()[0])
            cur = ''
        else:
            cur += c
    return method_name, param_types


if __name__ == '__main__':

    # 测试用例
    test_cases = [
        "processData(int,int)",
        "public int processData(int[] array)",
        "private void updateUser(User<Profile > user, int id)",
        "protected <T> List<T> filterData(List<T> input)",
        "handleEvent(Event event, Callback<Void> callback)",
        "MyClass(String name, int value)",
        "complexMethod(Map<String, List<Integer>> data, int count)",
        "static final synchronized void resetCounter()",
        "buildProject(String projectName, BuilderOptions options)",
        "public static <K, V> Map<K, V> createMap(Class<K> keyType, Class<V> valueType)"
    ]

    for t in test_cases:
        try:
            result = extract_java_signature(t)
            print(f"原始签名: {t}")
            print(f"解析结果: {result}\n")
        except Exception as e:
            print(f"解析失败: {t}\n错误: {str(e)}\n")
