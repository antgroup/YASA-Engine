import re


class QidUnifyUtil:
    """
    统一各语言的qid处理工具
    """

    def __init__(self, value):
        self.value = value

    def remove_path(self):
        # 去掉开头"/"，并将所有"/"替换成"."
        if self.value is not None:
            self.value = re.sub(r'^/', '', self.value)
            self.value = self.value.replace('/', '.')
        return self

    def remove_syslib_from(self):
        # 去掉 syslib_from. 前缀
        if self.value and self.value.startswith("syslib_from."):
            self.value = self.value[len("syslib_from."):]
        return self

    def remove_chair(self):
        # Egg.Application -> app, Egg.Context -> ctx
        if self.value:
            self.value = self.value.replace("Egg.Application", "app")
            self.value = self.value.replace("Egg.Context", "ctx")
        return self

    def remove_parentheses(self):
        """
        去除所有括号及括号内内容（包括嵌套），如 foo(bar(baz)) -> foo
        """
        result = ''
        level = 0
        for char in self.value or '':
            if char == '(':
                level += 1
            elif char == ')':
                if level > 0:
                    level -= 1
            elif level == 0:
                result += char
        self.value = result
        return self

    def remove_block(self):
        """
        remove *_scope.<block_>写法，例如 "1.calculate.calculate_scope.<block_18_4_34_51>.process"
        ==> 1.calculate.process
        若 symbol.vtype == "symbol"，直接用 sid
        """
        if not self.value or "<block" not in self.value:
            return self

        temp = self.value.split('.')
        result = []
        for i, cur_str in enumerate(temp):
            pre_str = temp[i - 1] if i > 0 else 'NaN'
            if cur_str == f"{pre_str}_scope":
                continue
            if cur_str.startswith("<block"):
                continue
            result.append(cur_str)
        self.value = ".".join(result)
        return self

    def remove_instance(self):
        # 去掉 <instance>
        if self.value:
            self.value = self.value.replace("<instance>", "")
        return self

    def remove_global(self):
        # 去掉 <global>.
        if self.value:
            self.value = self.value.replace("<global>.", "")
        return self

    def get(self):
        return self.value

    @staticmethod
    def unify(str_value:str):
        unify_id = (QidUnifyUtil(str_value)
                    .remove_path()
                    .remove_syslib_from()
                    .remove_chair()
                    .remove_parentheses()
                    .remove_block()
                    .remove_instance()
                    .remove_global()
                    .get())
        return unify_id


# 用法示例
if __name__ == "__main__":
    # 假设 symbol 是 dict
    value = "com.example.dao.UserDAO<instance>.findById(userId).setName"
    print(QidUnifyUtil.unify(value))  # tp.2.func(app)