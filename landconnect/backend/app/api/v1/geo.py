from fastapi import APIRouter, Depends, HTTPException, Query, status
from geoalchemy2 import Geography
from geoalchemy2.functions import ST_Distance, ST_DWithin, ST_Intersects, ST_MakeEnvelope, ST_MakePoint, ST_SetSRID
from sqlalchemy import cast, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.domain import LandListing, User
from app.schemas.dto import ListingOut

router = APIRouter(prefix="/listings", tags=["Geospatial Search (PostGIS)"])


@router.get("/nearby")
async def search_nearby(
    lat: float = Query(..., ge=-90.0, le=90.0),
    lng: float = Query(..., ge=-180.0, le=180.0),
    radius_km: float = Query(25.0, ge=0.5, le=500.0),
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    origin = cast(ST_SetSRID(ST_MakePoint(lng, lat), 4326), Geography)
    radius_meters = radius_km * 1000.0

    distance_col = (ST_Distance(LandListing.location_geog, origin) / 1000.0).label("distance_km")
    stmt = (
        select(LandListing, distance_col)
        .where(ST_DWithin(LandListing.location_geog, origin, radius_meters))
        .order_by(distance_col.asc())
    )
    rows = (await db.execute(stmt)).all()
    results = []
    for listing, dist_km in rows:
        dto = ListingOut.model_validate(listing)
        dto.distance_km = round(float(dist_km), 2)
        results.append(dto)

    return {"count": len(results), "radius_km": radius_km, "listings": results}


@router.get("/bbox")
async def search_bbox(
    min_lng: float = Query(..., ge=-180.0, le=180.0),
    min_lat: float = Query(..., ge=-90.0, le=90.0),
    max_lng: float = Query(..., ge=-180.0, le=180.0),
    max_lat: float = Query(..., ge=-90.0, le=90.0),
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if min_lng > max_lng or min_lat > max_lat:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid bounding box: min coordinates must be less than or equal to max coordinates",
        )
    envelope = cast(ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326), Geography)
    stmt = select(LandListing).where(ST_Intersects(LandListing.location_geog, envelope))
    rows = (await db.scalars(stmt)).all()
    return {"count": len(rows), "listings": [ListingOut.model_validate(r) for r in rows]}
