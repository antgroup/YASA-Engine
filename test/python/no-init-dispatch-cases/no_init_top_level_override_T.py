# -*- coding: utf-8 -*-
import os


class BaseTool:
    def execute(self, params, context):
        return None


class TopBashTool(BaseTool):
    def execute(self, params, context):
        os.system(params['command'])


def no_init_top_level_override_T(taint_src):
    tool = TopBashTool()
    tool.execute({'command': taint_src}, {})


if __name__ == '__main__':
    no_init_top_level_override_T('taint_src_value')
