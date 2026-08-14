# -*- coding: utf-8 -*-
import os


def no_init_untainted_F(taint_src):
    class Runner:
        def run(self, value):
            taint_sink(value)

    runner = Runner()
    runner.run('safe_value')


def taint_sink(value):
    os.system(value)


if __name__ == '__main__':
    no_init_untainted_F('taint_src_value')
