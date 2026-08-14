from fastapi import APIRouter, BackgroundTasks
import os


router = APIRouter()


class VerifyRequest:
    input: str


async def frontend_verify_sync(task_id: str, request: VerifyRequest):
    os.system(request.input)


def schedule_verification(background_tasks: BackgroundTasks, task_id: str, request: VerifyRequest):
    background_tasks.add_task(frontend_verify_sync, task_id, request)


@router.post('/verify')
async def endpoint(background_tasks: BackgroundTasks, task_id: str, request: VerifyRequest, taint_src):
    request = taint_src
    schedule_verification(background_tasks, task_id, request)


class LocalQueue:
    def add_task(self, callback, value):
        callback(value)


async def decoy(background_tasks: LocalQueue, task_id: str, request: VerifyRequest, taint_src):
    request = taint_src
    background_tasks.add_task(frontend_verify_sync, task_id, request)
