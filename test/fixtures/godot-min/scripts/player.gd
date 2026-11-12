extends Node2D

## Minimal player controller for the sverse-mcp scan fixture.
## Nothing here is monetised; the scene names are what the heuristics inspect.

const SPEED := 320.0

var velocity := Vector2.ZERO

func _physics_process(delta: float) -> void:
	var direction := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	velocity = direction * SPEED
	position += velocity * delta
