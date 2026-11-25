import json
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from geoalchemy2.elements import WKTElement
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import check_idempotency, get_current_user, require_user_roles
from app.models.domain import LandListing, LandType, User, UserRole, VerificationStatus
from app.schemas.dto import ListingCreateRequest, ListingOut, ListingUpdateRequest, ListingVerifyRequest

router = APIRouter(prefix="/listings", tags=["Land Listings"])


def _polygon_to_wkt(lat: float, lng: float, polygon_geojson: dict | None) -> str:
    if polygon_geojson and polygon_geojson.get("type") == "Polygon":
        ring = polygon_geojson["coordinates"][0]
        coords_str = ", ".join(f"{pt[0]} {pt[1]}" for pt in ring)
        return f"POLYGON(({coords_str}))"
    d = 0.0011
    return (
        f"POLYGON(({lng - d} {lat + d}, {lng + d} {lat + d}, "
        f"{lng + d} {lat - d}, {lng - d} {lat - d}, {lng - d} {lat + d}))"
    )


@router.get("", response_model=list[ListingOut])
async def list_listings(
    land_type: LandType | None = None,
    city: str | None = None,
    min_price: int | None = Query(default=None, ge=0),
    max_price: int | None = Query(default=None, ge=0),
    q: str | None = None,
    sort: str = Query(default="newest", pattern="^(newest|price_asc|price_desc)$"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(LandListing)
    if land_type:
        stmt = stmt.where(LandListing.land_type == land_type)
    if city:
        stmt = stmt.where(LandListing.city.ilike(city.strip()))
    if min_price is not None:
        stmt = stmt.where(LandListing.price_inr >= min_price)
    if max_price is not None:
        stmt = stmt.where(LandListing.price_inr <= max_price)
    if q and q.strip():
        needle = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                LandListing.title.ilike(needle),
                LandListing.locality.ilike(needle),
                LandListing.city.ilike(needle),
                LandListing.zoning_status.ilike(needle),
            )
        )
    if sort == "price_asc":
        stmt = stmt.order_by(LandListing.price_inr.asc())
    elif sort == "price_desc":
        stmt = stmt.order_by(LandListing.price_inr.desc())
    else:
        stmt = stmt.order_by(LandListing.created_at.desc())

    rows = (await db.scalars(stmt)).all()
    return rows


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ListingOut)
async def create_listing(
    body: ListingCreateRequest,
    request: Request,
    idemp_cache_key: str | None = Depends(check_idempotency),
    current_user: User = Depends(require_user_roles(UserRole.SELLER, UserRole.BROKER)),
    db: AsyncSession = Depends(get_db),
):
    cached_body = getattr(request.state, "idempotent_cached_body", None)
    if cached_body:
        return JSONResponse(
            content=json.loads(cached_body),
            status_code=status.HTTP_201_CREATED,
            headers={"X-Idempotent-Replay": "true"},
        )

    point_wkt = f"POINT({body.longitude} {body.latitude})"
    poly_wkt = _polygon_to_wkt(body.latitude, body.longitude, body.polygon_geojson)

    listing = LandListing(
        title=body.title,
        description=body.description,
        price_inr=body.price_inr,
        area_sqft=body.area_sqft,
        area_acres=round(body.area_sqft / 43560.0, 2),
        land_type=body.land_type,
        zoning_status=body.zoning_status,
        verification_status=(
            VerificationStatus.VERIFIED
            if current_user.role == UserRole.BROKER
            else VerificationStatus.PENDING_SURVEY
        ),
        locality=body.locality,
        city=body.city,
        latitude=body.latitude,
        longitude=body.longitude,
        location_geog=WKTElement(point_wkt, srid=4326),
        boundary_geom=WKTElement(poly_wkt, srid=4326),
        polygon_geojson=body.polygon_geojson,
        images=body.images,
        owner_uuid=current_user.user_uuid,
        broker_uuid=current_user.user_uuid if current_user.role == UserRole.BROKER else None,
        version=1,
    )
    db.add(listing)
    await db.commit()
    await db.refresh(listing)

    if idemp_cache_key:
        serialized = ListingOut.model_validate(listing).model_dump_json()
        await request.app.state.redis.set(idemp_cache_key, serialized, ex=86400)

    return listing


@router.patch("/{listing_id}", response_model=ListingOut)
async def update_listing(
    listing_id: str,
    body: ListingUpdateRequest,
    current_user: User = Depends(require_user_roles(UserRole.SELLER, UserRole.BROKER)),
    db: AsyncSession = Depends(get_db),
):
    listing = await db.get(LandListing, listing_id)
    if not listing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found")
    if current_user.role == UserRole.SELLER and listing.owner_uuid != current_user.user_uuid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sellers may only edit their own listings",
        )
    if body.version != listing.version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Optimistic lock conflict: expected version {listing.version}",
        )

    if body.title is not None:
        listing.title = body.title
    if body.description is not None:
        listing.description = body.description
    if body.price_inr is not None:
        listing.price_inr = body.price_inr
    if body.zoning_status is not None:
        listing.zoning_status = body.zoning_status

    listing.version += 1
    await db.commit()
    await db.refresh(listing)
    return listing


@router.delete("/{listing_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_listing(
    listing_id: str,
    current_user: User = Depends(require_user_roles(UserRole.SELLER, UserRole.BROKER)),
    db: AsyncSession = Depends(get_db),
):
    listing = await db.get(LandListing, listing_id)
    if not listing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found")
    if current_user.role == UserRole.SELLER and listing.owner_uuid != current_user.user_uuid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sellers may only delete their own listings",
        )
    await db.delete(listing)
    await db.commit()


@router.patch("/{listing_id}/verify", response_model=ListingOut)
async def verify_listing(
    listing_id: str,
    body: ListingVerifyRequest,
    current_user: User = Depends(require_user_roles(UserRole.BROKER)),
    db: AsyncSession = Depends(get_db),
):
    listing = await db.get(LandListing, listing_id)
    if not listing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found")
    listing.verification_status = body.verification_status
    listing.broker_uuid = listing.broker_uuid or current_user.user_uuid
    listing.version += 1
    await db.commit()
    await db.refresh(listing)
    return listing
