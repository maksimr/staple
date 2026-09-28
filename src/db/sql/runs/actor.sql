SELECT agentId, companyId FROM runs WHERE token = $token AND status = 'running'
