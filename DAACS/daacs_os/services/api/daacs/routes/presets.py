"""Preset endpoints extracted from the workflow router."""

from typing import Dict

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api", tags=["presets"])


@router.get("/presets")
async def list_presets() -> list[Dict[str, object]]:
    from ..templates.presets import list_presets as _list

    return _list()


@router.get("/presets/{preset_id}")
async def get_preset(preset_id: str) -> Dict[str, object]:
    from ..templates.presets import get_preset as _get

    preset = _get(preset_id)
    if preset is None:
        raise HTTPException(status_code=404, detail=f"Preset '{preset_id}' not found")
    return preset.to_dict()
