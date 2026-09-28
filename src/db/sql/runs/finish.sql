UPDATE runs SET status = $status, exitCode = $exitCode, summary = $summary, finishedAt = CURRENT_TIMESTAMP
WHERE id = $id AND status = 'running'
