UPDATE runs SET status = 'running', token = $token, startedAt = CURRENT_TIMESTAMP WHERE id = $id
