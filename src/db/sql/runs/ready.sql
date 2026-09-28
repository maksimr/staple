SELECT r.* FROM runs r JOIN agents a ON a.id = r.agentId
WHERE r.status = 'queued' AND a.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM runs x WHERE x.agentId = r.agentId AND x.status = 'running')
ORDER BY r.rowid
