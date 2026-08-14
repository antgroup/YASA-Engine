from fastapi import BackgroundTasks as BT
import fastapi as api
import os


def sink(value):
    os.system(value)


def void_callback(task_id, request=None):
    sink(task_id)


def aborted_callback(task_id):
    raise RuntimeError(task_id)


def schedule_alias(tasks: BT, task_id, request):
    tasks.add_task(void_callback, task_id, request=request)


def schedule_module(tasks: api.BackgroundTasks, task_id):
    tasks.add_task(void_callback, task_id)


class BackgroundTasks:
    def add_task(self, callback, value):
        callback(value)


def schedule_decoy(tasks: BackgroundTasks, task_id):
    tasks.add_task(void_callback, task_id)


def schedule_abort(tasks: BT, task_id):
    tasks.add_task(aborted_callback, task_id)
