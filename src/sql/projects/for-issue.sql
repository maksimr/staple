SELECT p.* FROM projects p JOIN issues i ON i.projectId = p.id WHERE i.id = $issueId
