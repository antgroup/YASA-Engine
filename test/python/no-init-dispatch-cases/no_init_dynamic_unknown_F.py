# -*- coding: utf-8 -*-
import os


def no_init_dynamic_unknown_F(taint_src):
    class Runner:
        def run(self, value):
            taint_sink(value)

    runner = Runner()
    method = getattr(runner, 'run')
    method(taint_src)


def taint_sink(value):
    os.system(value)


if __name__ == '__main__':
    no_init_dynamic_unknown_F('taint_src_value')
