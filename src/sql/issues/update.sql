UPDATE issues
SET title = $title, description = $description, status = $status,
    assigneeAgentId = $assigneeAgentId, parentId = $parentId, projectId = $projectId
WHERE id = $id
