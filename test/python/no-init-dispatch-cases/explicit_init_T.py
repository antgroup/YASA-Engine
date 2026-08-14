# -*- coding: utf-8 -*-
import os


def explicit_init_T(taint_src):
    class Runner:
        def __init__(self, value):
            self.value = value

        def run(self):
            taint_sink(self.value)

    runner = Runner(taint_src)
    runner.run()


def taint_sink(value):
    os.system(value)


if __name__ == '__main__':
    explicit_init_T('taint_src_value')
