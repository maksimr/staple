UPDATE runs SET status = 'cancelled', finishedAt = CURRENT_TIMESTAMP WHERE id = $id AND status IN ('queued', 'running')
