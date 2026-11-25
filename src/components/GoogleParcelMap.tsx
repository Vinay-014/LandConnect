/// <reference types="google.maps" />
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  APILoadingStatus,
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  useAdvancedMarkerRef,
  useApiLoadingStatus,
  useMap,
} from '@vis.gl/react-google-maps';
import type { LandListing } from '../types';
import { formatInrPrice } from '../api/client';

interface GoogleParcelMapProps {
  apiKey: string;
  listings: LandListing[];
  selectedId: string | null;
  onSelectListing: (listing: LandListing) => void;
  searchCenter?: { lat: number; lng: number; radiusKm: number } | null;
  pickerMode?: boolean;
  pickedCoords?: { lat: number; lng: number } | null;
  onPickCoords?: (lat: number, lng: number) => void;
  onBoundsChange?: (bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }) => void;
  heightClass?: string;
}

const COLOR_BY_TYPE: Record<string, string> = {
  AGRICULTURAL: '#15803D',
  RESIDENTIAL: '#008069',
  COMMERCIAL: '#0F766E',
  INDUSTRIAL: '#475569',
};

function PolygonAndRadiusOverlay({
  listings,
  selectedId,
  onSelectListing,
  searchCenter,
  onBoundsChange,
}: {
  listings: LandListing[];
  selectedId: string | null;
  onSelectListing: (listing: LandListing) => void;
  searchCenter?: { lat: number; lng: number; radiusKm: number } | null;
  onBoundsChange?: (bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }) => void;
}) {
  const map = useMap();
  const onSelectRef = useRef(onSelectListing);
  const onBoundsRef = useRef(onBoundsChange);
  onSelectRef.current = onSelectListing;
  onBoundsRef.current = onBoundsChange;

  useEffect(() => {
    if (!map) return;

    const overlays: Array<{ setMap: (m: google.maps.Map | null) => void }> = [];

    if (searchCenter) {
      const circle = new google.maps.Circle({
        map,
        center: { lat: searchCenter.lat, lng: searchCenter.lng },
        radius: searchCenter.radiusKm * 1000,
        strokeColor: '#008069',
        strokeOpacity: 0.9,
        strokeWeight: 2,
        fillColor: '#008069',
        fillOpacity: 0.08,
        clickable: false,
      });
      overlays.push(circle);
    }

    for (const item of listings) {
      const ring = item.polygon_geojson?.coordinates?.[0];
      if (!ring || ring.length < 3) continue;
      const isSelected = item.id === selectedId;
      const color = isSelected ? '#075E54' : COLOR_BY_TYPE[item.land_type] || '#008069';

      const paths = ring.map(([lng, lat]) => ({ lat, lng }));
      const polygon = new google.maps.Polygon({
        map,
        paths,
        strokeColor: color,
        strokeOpacity: 0.95,
        strokeWeight: isSelected ? 3 : 2,
        fillColor: color,
        fillOpacity: isSelected ? 0.3 : 0.14,
      });
      polygon.addListener('click', () => onSelectRef.current(item));
      overlays.push(polygon);
    }

    return () => {
      for (const overlay of overlays) {
        google.maps.event.clearInstanceListeners(overlay);
        overlay.setMap(null);
      }
    };
  }, [map, listings, selectedId, searchCenter]);

  useEffect(() => {
    if (!map || !searchCenter) return;
    map.panTo({ lat: searchCenter.lat, lng: searchCenter.lng });
  }, [map, searchCenter?.lat, searchCenter?.lng]);

  useEffect(() => {
    if (!map) return;
    const listener = map.addListener('idle', () => {
      if (!onBoundsRef.current) return;
      const bounds = map.getBounds();
      if (!bounds) return;
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      onBoundsRef.current({
        minLng: Number(sw.lng().toFixed(5)),
        minLat: Number(sw.lat().toFixed(5)),
        maxLng: Number(ne.lng().toFixed(5)),
        maxLat: Number(ne.lat().toFixed(5)),
      });
    });
    return () => {
      listener.remove();
    };
  }, [map]);

  return null;
}

function ParcelAdvancedMarker({
  listing,
  isSelected,
  onClick,
}: {
  listing: LandListing;
  isSelected: boolean;
  onClick: (listing: LandListing, marker: google.maps.marker.AdvancedMarkerElement | null) => void;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const baseColor = isSelected ? '#075E54' : COLOR_BY_TYPE[listing.land_type] || '#008069';

  return (
    <AdvancedMarker
      ref={markerRef}
      position={{ lat: listing.latitude, lng: listing.longitude }}
      zIndex={isSelected ? 100 : 10}
      title={`${listing.locality} · ${formatInrPrice(listing.price_inr)}`}
      onClick={() => onClick(listing, marker)}
    >
      <Pin
        background={baseColor}
        borderColor="#FFFFFF"
        glyphColor="#FFFFFF"
        scale={isSelected ? 1.25 : 1.0}
      />
    </AdvancedMarker>
  );
}

function ApiStatusWatcher({ onFailure }: { onFailure: () => void }) {
  const status = useApiLoadingStatus();
  useEffect(() => {
    if (status === APILoadingStatus.AUTH_FAILURE || status === APILoadingStatus.FAILED) {
      window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
      onFailure();
    }
  }, [status, onFailure]);
  return null;
}

export function GoogleParcelMap({
  apiKey,
  listings,
  selectedId,
  onSelectListing,
  searchCenter,
  pickerMode = false,
  pickedCoords,
  onPickCoords,
  onBoundsChange,
  heightClass = 'h-[420px] lg:h-full',
}: GoogleParcelMapProps) {
  const [infoListing, setInfoListing] = useState<LandListing | null>(null);
  const [infoAnchor, setInfoAnchor] = useState<google.maps.marker.AdvancedMarkerElement | null>(null);
  const [mapTypeId, setMapTypeId] = useState<'roadmap' | 'hybrid' | 'terrain'>('roadmap');
  const [mapLoadFailed, setMapLoadFailed] = useState(false);

  const defaultCenter = useMemo(() => {
    if (pickedCoords) return { lat: pickedCoords.lat, lng: pickedCoords.lng };
    if (searchCenter) return { lat: searchCenter.lat, lng: searchCenter.lng };
    return { lat: 13.75, lng: 76.35 };
  }, [pickedCoords, searchCenter]);

  const handleMarkerClick = useCallback(
    (listing: LandListing, marker: google.maps.marker.AdvancedMarkerElement | null) => {
      onSelectListing(listing);
      setInfoListing(listing);
      setInfoAnchor(marker);
    },
    [onSelectListing],
  );

  const handleFailure = useCallback(() => {
    setMapLoadFailed(true);
  }, []);

  useEffect(() => {
    if (infoListing && !listings.some((l) => l.id === infoListing.id)) {
      setInfoListing(null);
      setInfoAnchor(null);
    }
  }, [listings, infoListing]);

  return (
    <div
      className={`relative w-full ${heightClass} min-h-[220px] rounded-xl overflow-hidden border border-slate-200 bg-slate-100`}
      aria-label={pickerMode ? 'Google Maps coordinate picker' : 'Google Maps parcel explorer'}
    >
      <APIProvider apiKey={apiKey} libraries={['marker']} language="en" region="IN">
        <ApiStatusWatcher onFailure={handleFailure} />
        <GoogleMap
          mapId="DEMO_MAP_ID"
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          defaultCenter={defaultCenter}
          defaultZoom={pickerMode ? 12 : 7}
          mapTypeId={mapTypeId}
          gestureHandling="greedy"
          streetViewControl={false}
          mapTypeControl={false}
          fullscreenControl={true}
          onClick={(ev) => {
            if (onPickCoords && ev.detail.latLng) {
              onPickCoords(
                Number(ev.detail.latLng.lat.toFixed(6)),
                Number(ev.detail.latLng.lng.toFixed(6)),
              );
            } else {
              setInfoListing(null);
            }
          }}
          style={{ width: '100%', height: '100%' }}
        >
          <PolygonAndRadiusOverlay
            listings={listings}
            selectedId={selectedId}
            onSelectListing={onSelectListing}
            searchCenter={searchCenter}
            onBoundsChange={onBoundsChange}
          />

          {!pickerMode &&
            listings.map((item) => (
              <ParcelAdvancedMarker
                key={item.id}
                listing={item}
                isSelected={item.id === selectedId}
                onClick={handleMarkerClick}
              />
            ))}

          {pickerMode && pickedCoords && (
            <AdvancedMarker position={pickedCoords} title="Selected Parcel Pin">
              <Pin background="#008069" borderColor="#FFFFFF" glyphColor="#FFFFFF" scale={1.15} />
            </AdvancedMarker>
          )}

          {infoListing && infoAnchor && (
            <InfoWindow
              anchor={infoAnchor}
              maxWidth={240}
              onCloseClick={() => {
                setInfoListing(null);
                setInfoAnchor(null);
              }}
            >
              <div className="p-1 text-slate-900">
                <div className="text-[11px] font-semibold text-[#075E54]">
                  {infoListing.locality}, {infoListing.city}
                </div>
                <div className="text-xs font-medium mt-0.5">{infoListing.title}</div>
                <div className="text-[11px] font-mono text-slate-600 mt-1">
                  {formatInrPrice(infoListing.price_inr)} · {infoListing.area_acres} ac
                </div>
              </div>
            </InfoWindow>
          )}
        </GoogleMap>
      </APIProvider>

      {/* Compact map-layer switcher */}
      <div className="absolute top-2.5 left-2.5 z-10 flex items-center flex-wrap gap-1 max-w-[calc(100%-1.25rem)] bg-white/95 border border-slate-200 rounded-lg p-0.5 shadow-sm">
        {(['roadmap', 'hybrid', 'terrain'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setMapTypeId(mode)}
            className={`px-2 py-1 rounded text-[11px] font-medium capitalize transition-colors ${
              mapTypeId === mode
                ? 'bg-[#008069] text-white'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>

      {mapLoadFailed && (
        <div className="absolute inset-x-3 bottom-3 z-10 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
          Google Maps is unavailable right now. Switch to Standard Map above or check your key quota.
        </div>
      )}
    </div>
  );
}
