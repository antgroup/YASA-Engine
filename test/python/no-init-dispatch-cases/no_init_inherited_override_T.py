# -*- coding: utf-8 -*-
import os


def no_init_inherited_override_T(taint_src):
    class Tool:
        def execute(self, params, context):
            return None

    class BashTool(Tool):
        def execute(self, params, context):
            os.system(params['command'])

    tool = BashTool()
    tool.execute({'command': taint_src}, {})


if __name__ == '__main__':
    no_init_inherited_override_T('taint_src_value')
