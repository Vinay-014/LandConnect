import { useEffect, useRef } from 'react';
import L from 'leaflet';
import type { LandListing } from '../types';
import { formatInrPrice } from '../api/client';

interface LeafletMapProps {
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

export function LeafletMap({
  listings,
  selectedId,
  onSelectListing,
  searchCenter,
  pickerMode = false,
  pickedCoords,
  onPickCoords,
  onBoundsChange,
  heightClass = 'h-[420px] lg:h-full',
}: LeafletMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const pickerMarkerRef = useRef<L.CircleMarker | null>(null);

  const onBoundsChangeRef = useRef(onBoundsChange);
  const onPickCoordsRef = useRef(onPickCoords);
  const onSelectListingRef = useRef(onSelectListing);
  onBoundsChangeRef.current = onBoundsChange;
  onPickCoordsRef.current = onPickCoords;
  onSelectListingRef.current = onSelectListing;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const initialCenter: [number, number] = pickedCoords
      ? [pickedCoords.lat, pickedCoords.lng]
      : [13.75, 76.35];

    const map = L.map(container, {
      center: initialCenter,
      zoom: pickerMode ? 12 : 7,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const layerGroup = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerGroupRef.current = layerGroup;

    map.on('click', (e: L.LeafletMouseEvent) => {
      if (onPickCoordsRef.current) {
        onPickCoordsRef.current(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6)));
      }
    });

    map.on('moveend', () => {
      if (onBoundsChangeRef.current) {
        const b = map.getBounds();
        onBoundsChangeRef.current({
          minLng: Number(b.getWest().toFixed(5)),
          minLat: Number(b.getSouth().toFixed(5)),
          maxLng: Number(b.getEast().toFixed(5)),
          maxLat: Number(b.getNorth().toFixed(5)),
        });
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, [pickerMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !searchCenter) return;
    map.panTo([searchCenter.lat, searchCenter.lng], { animate: true });
  }, [searchCenter?.lat, searchCenter?.lng]);

  useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();

    if (searchCenter) {
      L.circle([searchCenter.lat, searchCenter.lng], {
        radius: searchCenter.radiusKm * 1000,
        color: '#008069',
        weight: 1.5,
        fillColor: '#008069',
        fillOpacity: 0.08,
        dashArray: '5, 5',
      }).addTo(group);
    }

    for (const item of listings) {
      const isSelected = item.id === selectedId;
      const colorByType: Record<string, string> = {
        AGRICULTURAL: '#15803D',
        RESIDENTIAL: '#008069',
        COMMERCIAL: '#0F766E',
        INDUSTRIAL: '#475569',
      };
      const color = isSelected ? '#075E54' : colorByType[item.land_type] || '#008069';

      if (item.polygon_geojson?.coordinates?.[0]?.length) {
        const latLngs = item.polygon_geojson.coordinates[0].map(
          ([lng, lat]) => [lat, lng] as [number, number],
        );
        const poly = L.polygon(latLngs, {
          color,
          weight: isSelected ? 3 : 2,
          fillColor: color,
          fillOpacity: isSelected ? 0.32 : 0.16,
        });
        poly.on('click', () => onSelectListingRef.current(item));
        poly.addTo(group);
      }

      const marker = L.circleMarker([item.latitude, item.longitude], {
        radius: isSelected ? 10 : 7,
        color: '#FFFFFF',
        weight: 2.5,
        fillColor: color,
        fillOpacity: 1,
      });
      marker.bindTooltip(
        `<div style="font-family:DM Sans,sans-serif;font-size:12px;">
          <strong>${item.locality}</strong><br/>
          <span>${formatInrPrice(item.price_inr)} · ${item.area_acres} ac</span>
        </div>`,
        { direction: 'top', offset: [0, -8] },
      );
      marker.on('click', () => onSelectListingRef.current(item));
      marker.addTo(group);
    }
  }, [listings, selectedId, searchCenter]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !pickerMode) return;
    if (pickerMarkerRef.current) {
      pickerMarkerRef.current.remove();
      pickerMarkerRef.current = null;
    }
    if (pickedCoords) {
      pickerMarkerRef.current = L.circleMarker([pickedCoords.lat, pickedCoords.lng], {
        radius: 9,
        color: '#FFFFFF',
        weight: 3,
        fillColor: '#008069',
        fillOpacity: 1,
      }).addTo(map);
    }
  }, [pickedCoords, pickerMode]);

  return (
    <div
      ref={containerRef}
      className={`w-full ${heightClass} rounded-xl overflow-hidden border border-slate-200 bg-slate-100`}
      aria-label={pickerMode ? 'Geolocation parcel picker map' : 'Land listings geospatial map'}
    />
  );
}
