import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { Upload, X } from 'lucide-react';
import { apiRequest, ApiError } from '../api/client';
import type { LandListing, LandType } from '../types';
import { GoogleParcelMap } from './GoogleParcelMap';
import { LeafletMap } from './LeafletMap';

interface ListingModalProps {
  existing?: LandListing | null;
  mapsApiKey?: string;
  onClose: () => void;
  onSaved: (listing: LandListing) => void;
}

export function ListingModal({ existing, mapsApiKey, onClose, onSaved }: ListingModalProps) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [priceInr, setPriceInr] = useState(String(existing?.price_inr ?? 5000000));
  const [areaSqft, setAreaSqft] = useState(String(existing?.area_sqft ?? 2400));
  const [landType, setLandType] = useState<LandType>(existing?.land_type ?? 'RESIDENTIAL');
  const [zoningStatus, setZoningStatus] = useState(
    existing?.zoning_status ?? 'Approved Layout · Clear Title EC',
  );
  const [locality, setLocality] = useState(existing?.locality ?? 'Bogadi Ring Road');
  const [city, setCity] = useState(existing?.city ?? 'Mysuru');
  const [coords, setCoords] = useState<{ lat: number; lng: number }>({
    lat: existing?.latitude ?? 12.2889,
    lng: existing?.longitude ?? 76.5974,
  });
  const [uploadedImages, setUploadedImages] = useState<string[]>(existing?.images ?? []);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleImageUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Failed to read image'));
        reader.readAsDataURL(file);
      });
      const res = await apiRequest<{ url: string }>('/api/v1/listings/upload-image', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, data_url: dataUrl }),
      });
      setUploadedImages((prev) => [res.url, ...prev]);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Image upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      if (existing) {
        const updated = await apiRequest<LandListing>(`/api/v1/listings/${existing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title,
            description,
            price_inr: Number(priceInr),
            zoning_status: zoningStatus,
            version: existing.version,
          }),
        });
        onSaved(updated);
      } else {
        const idempotencyKey = `lst_${crypto.randomUUID()}`;
        const created = await apiRequest<LandListing>('/api/v1/listings', {
          method: 'POST',
          idempotencyKey,
          body: JSON.stringify({
            title,
            description,
            price_inr: Number(priceInr),
            area_sqft: Number(areaSqft),
            land_type: landType,
            zoning_status: zoningStatus,
            locality,
            city,
            latitude: coords.lat,
            longitude: coords.lng,
            images: uploadedImages,
          }),
        });
        onSaved(created);
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Failed to save listing');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={existing ? 'Edit land listing' : 'Create land listing'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl border border-slate-200 w-full max-w-2xl max-h-[92dvh] overflow-y-auto p-4 sm:p-6 overscroll-contain">
        <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-lg font-semibold text-[#111B21]">
              {existing ? 'Edit Land Listing' : 'Publish Land Parcel'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {existing
                ? 'Update pricing, zoning notes, or property details for this parcel.'
                : 'Click on the map to pin the parcel location and outline its boundary.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] rounded-xl hover:bg-slate-100 flex items-center justify-center text-slate-500"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-xl bg-red-50 border border-red-200 px-3.5 py-2.5 text-xs text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Parcel Title</label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Yelahanka Doddaballapur Road 0.5-Acre Commercial Plot"
              className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Price (INR)</label>
              <input
                type="number"
                required
                min={100000}
                value={priceInr}
                onChange={(e) => setPriceInr(e.target.value)}
                className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-[#008069]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Area (sq. ft.)</label>
              <input
                type="number"
                required
                disabled={Boolean(existing)}
                value={areaSqft}
                onChange={(e) => setAreaSqft(e.target.value)}
                className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm font-mono tabular-nums disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Land Type</label>
              <select
                disabled={Boolean(existing)}
                value={landType}
                onChange={(e) => setLandType(e.target.value as LandType)}
                className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm bg-white disabled:bg-slate-50"
              >
                <option value="AGRICULTURAL">Agricultural</option>
                <option value="RESIDENTIAL">Residential</option>
                <option value="COMMERCIAL">Commercial</option>
                <option value="INDUSTRIAL">Industrial</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Locality</label>
              <input
                type="text"
                disabled={Boolean(existing)}
                value={locality}
                onChange={(e) => setLocality(e.target.value)}
                className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">City / District</label>
              <input
                type="text"
                disabled={Boolean(existing)}
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Mysuru, Mangaluru, Hubballi"
                className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Zoning / Title Status</label>
              <input
                type="text"
                value={zoningStatus}
                onChange={(e) => setZoningStatus(e.target.value)}
                className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Description</label>
            <textarea
              rows={3}
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Road width, water source, conversion status, EC clarity..."
              className="w-full p-3.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
            />
          </div>

          {!existing && (
            <>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-slate-700">
                    Pin Parcel Location (Click map to drop pin)
                  </label>
                  <span className="text-xs font-mono tabular-nums text-slate-500">
                    {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
                  </span>
                </div>
                {mapsApiKey ? (
                  <GoogleParcelMap
                    apiKey={mapsApiKey}
                    listings={[]}
                    selectedId={null}
                    onSelectListing={() => {}}
                    pickerMode
                    pickedCoords={coords}
                    onPickCoords={(lat, lng) => setCoords({ lat, lng })}
                    heightClass="h-[220px]"
                  />
                ) : (
                  <LeafletMap
                    listings={[]}
                    selectedId={null}
                    onSelectListing={() => {}}
                    pickerMode
                    pickedCoords={coords}
                    onPickCoords={(lat, lng) => setCoords({ lat, lng })}
                    heightClass="h-[220px]"
                  />
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Site Photo Upload (Optional)
                </label>
                <div className="flex items-center gap-3 flex-wrap">
                  <label className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 flex items-center gap-2 cursor-pointer">
                    <Upload className="w-4 h-4" />
                    <span>{uploading ? 'Uploading...' : 'Upload Image'}</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleImageUpload}
                      className="hidden"
                    />
                  </label>
                  {uploadedImages.map((img) => (
                    <img
                      key={img}
                      src={img}
                      alt="Uploaded parcel preview"
                      className="h-11 w-16 object-cover rounded-lg border border-slate-200"
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="pt-3 border-t border-slate-100 flex flex-col-reverse sm:flex-row sm:items-center justify-end gap-2.5 sm:gap-3">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || uploading}
              className="min-h-[44px] px-5 py-2 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {submitting ? 'Saving...' : existing ? 'Save Changes' : 'Publish Parcel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
