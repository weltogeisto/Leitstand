"""Shared model catalog and strict conversion of saved selections into argv."""
import json
from pathlib import Path

CATALOG = json.loads(Path(__file__).with_name("work-models.json").read_text(encoding="utf-8"))["platforms"]


def validate(platform, settings):
    if not isinstance(settings, dict) or set(settings) != {"model", "effort"}:
        raise ValueError("Invalid work settings: choose a model and reasoning effort")
    provider = CATALOG.get(platform, {})
    model = next((m for m in provider.get("models", []) if m["id"] == settings["model"]), None)
    if not model or not isinstance(settings["effort"], str) or settings["effort"] not in model["efforts"]:
        raise ValueError("Unsupported work model or reasoning effort; choose from the Work screen")
    return {"model": model["id"], "effort": settings["effort"]}


def cli_args(platform, settings):
    if settings is None:
        return []  # Legacy tasks keep the installed runner defaults.
    chosen = validate(platform, settings)
    if platform == "codex":
        return ["--model", chosen["model"], "-c", "model_reasoning_effort=" + json.dumps(chosen["effort"])]
    return ["--model", chosen["model"], "--effort", chosen["effort"]]
