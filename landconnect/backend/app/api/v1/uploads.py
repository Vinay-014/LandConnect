import os
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.core.config import get_settings
from app.core.security import require_user_roles
from app.models.domain import User, UserRole

settings = get_settings()
router = APIRouter(prefix="/uploads", tags=["Media Storage"])

MAX_FILE_BYTES = 5 * 1024 * 1024  # 5 MB


def _detect_image_ext(content: bytes) -> str | None:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if content.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if content.startswith(b"RIFF") and len(content) >= 12 and content[8:12] == b"WEBP":
        return "webp"
    return None


@router.post("/parcel-image", status_code=status.HTTP_201_CREATED)
async def upload_parcel_image(
    file: UploadFile = File(...),
    _current_user: User = Depends(require_user_roles(UserRole.SELLER, UserRole.BROKER)),
):
    content = await file.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Image exceeds 5 MB size cap",
        )

    ext = _detect_image_ext(content)
    if not ext:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image magic bytes. Allowed: PNG, JPEG, WEBP",
        )

    base_dir = Path(settings.UPLOAD_DIR).resolve()
    base_dir.mkdir(parents=True, exist_ok=True)
    safe_name = f"parcel_{uuid.uuid4().hex[:12]}.{ext}"
    dest = (base_dir / safe_name).resolve()
    if not str(dest).startswith(str(base_dir) + os.sep):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid file path")

    dest.write_bytes(content)
    return {"url": f"/uploads/{safe_name}", "size_bytes": len(content)}
