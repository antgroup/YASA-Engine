# -*- coding: utf-8 -*-
from imported_child_T import ImportedBashTool


def no_init_imported_override_T(taint_src):
    tool = ImportedBashTool()
    tool.execute({'command': taint_src}, {})


if __name__ == '__main__':
    no_init_imported_override_T('taint_src_value')
