UPDATE agents
SET name = $name, role = $role, reportsTo = $reportsTo, instructions = $instructions,
    model = $model, thinking = $thinking, status = $status
WHERE id = $id
