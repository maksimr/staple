UPDATE runs SET status = 'failed', summary = 'server restarted', finishedAt = CURRENT_TIMESTAMP WHERE status = 'running'
