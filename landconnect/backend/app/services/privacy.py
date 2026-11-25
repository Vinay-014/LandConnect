from app.models.domain import User
from app.schemas.dto import PublicUserOut


def to_privacy_safe_user(target: User, viewer_uuid: str | None) -> PublicUserOut:
    is_self = viewer_uuid is not None and viewer_uuid == target.user_uuid
    mutual_consent = (
        viewer_uuid is not None
        and target.show_contact_after_consent
        and viewer_uuid in (target.consented_peer_uuids or [])
    )
    revealed = is_self or mutual_consent
    return PublicUserOut(
        user_uuid=target.user_uuid,
        display_name=target.display_name,
        role=target.role,
        city=target.city,
        bio=target.bio,
        allow_calls=target.allow_calls,
        show_contact_after_consent=target.show_contact_after_consent,
        contact_revealed=revealed,
        masked_handle=f"@{target.user_uuid[:12]}",
        email=target.email if revealed else None,
        phone=target.phone if revealed else None,
        consented_peer_uuids=list(target.consented_peer_uuids or []) if is_self else None,
    )
