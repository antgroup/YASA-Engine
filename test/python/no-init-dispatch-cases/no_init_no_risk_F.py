# -*- coding: utf-8 -*-


def no_init_no_risk_F(taint_src):
    class Runner:
        def run(self, value):
            return value

    runner = Runner()
    runner.run(taint_src)


if __name__ == '__main__':
    no_init_no_risk_F('taint_src_value')
