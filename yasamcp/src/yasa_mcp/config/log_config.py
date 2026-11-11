import os
import logging
import logging.config
from datetime import date
from yasa_mcp.config import global_config

def setup_logger():
    # 日志默认写入文件 ~/.yasamcp/logs/YYYY-MM-DD.log；控制台日志默认关闭，避免污染 stdout
    # 除非显式设置 YASA_MCP_CONSOLE=1 才同时输出控制台
    handlers_list = ['file']
    if os.environ.get('YASA_MCP_CONSOLE') == '1':
        handlers_list = ['console', 'file']
    LOG_CONFIG = {
        'version': 1,
        'disable_existing_loggers': False,
        'formatters': {
            'standard': {
                'format': '[%(asctime)s][%(levelname)s][%(name)s][%(filename)s:%(lineno)d] %(message)s'
            },
        },
        'handlers': {
            'console': {
                'level': 'INFO',
                'class': 'logging.StreamHandler',
                'formatter': 'standard',
            },
            'file': {
                'level': 'INFO',
                'class': 'logging.handlers.TimedRotatingFileHandler',
                'formatter': 'standard',
                'filename': os.path.join(str(global_config.log_path), f"{date.today().isoformat()}.log"),
                'encoding': 'utf8',
                'when': 'midnight',
                'interval': 1,
                'utc': False
            },
        },
        'root': {
            'handlers': handlers_list,
            'level': 'INFO',
        },
    }
    logging.config.dictConfig(LOG_CONFIG)
