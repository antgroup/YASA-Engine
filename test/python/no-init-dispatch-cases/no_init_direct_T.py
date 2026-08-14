# -*- coding: utf-8 -*-
import os


def no_init_direct_T(taint_src):
    class Runner:
        def run(self, value):
            taint_sink(value)

    runner = Runner()
    runner.run(taint_src)


def taint_sink(value):
    os.system(value)


if __name__ == '__main__':
    no_init_direct_T('taint_src_value')
