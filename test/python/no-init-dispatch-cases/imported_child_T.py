# -*- coding: utf-8 -*-
import os
from imported_base import ImportedBaseTool


class ImportedBashTool(ImportedBaseTool):
    def execute(self, params, context):
        os.system(params['command'])
