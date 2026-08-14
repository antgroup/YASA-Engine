# -*- coding: utf-8 -*-
import os


def no_init_class_attr_T(taint_src):
    class Runner:
        value = taint_src

        def run(self):
            taint_sink(self.value)

    runner = Runner()
    runner.run()


def taint_sink(value):
    os.system(value)


if __name__ == '__main__':
    no_init_class_attr_T('taint_src_value')
