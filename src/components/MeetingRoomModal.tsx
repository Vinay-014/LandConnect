import { useEffect, useState, type FormEvent } from 'react';
import { Users, X } from 'lucide-react';
import { apiRequest, ApiError } from '../api/client';
import type { LandListing, PublicUserProfile } from '../types';

interface MeetingRoomModalProps {
  listings: LandListing[];
  users: PublicUserProfile[];
  currentUserUuid: string;
  onClose: () => void;
  onCreated: (roomId: string) => void;
}

export function MeetingRoomModal({
  listings,
  users,
  currentUserUuid,
  onClose,
  onCreated,
}: MeetingRoomModalProps) {
  const [listingId, setListingId] = useState(listings[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [selectedPeers, setSelectedPeers] = useState<string[]>(() => {
    const others = users.filter((u) => u.user_uuid !== currentUserUuid).slice(0, 2);
    return others.map((u) => u.user_uuid);
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const togglePeer = (uuid: string) => {
    setSelectedPeers((prev) =>
      prev.includes(uuid) ? prev.filter((id) => id !== uuid) : [...prev, uuid],
    );
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiRequest<{ room: { id: string } }>('/api/v1/chats/meeting-room', {
        method: 'POST',
        body: JSON.stringify({
          listing_id: listingId,
          title: title || undefined,
          participant_uuids: selectedPeers,
        }),
      });
      onCreated(res.room.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Failed to create Deal Room');
    } finally {
      setSubmitting(false);
    }
  };

  const eligibleUsers = users.filter((u) => u.user_uuid !== currentUserUuid);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Create Broker Meeting Room"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl border border-slate-200 w-full max-w-lg max-h-[92dvh] overflow-y-auto p-4 sm:p-6 overscroll-contain">
        <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <Users className="w-5 h-5 text-[#008069]" />
            <h2 className="text-lg font-semibold text-[#111B21]">Create Broker Deal Room</h2>
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
            <label className="block text-xs font-medium text-slate-700 mb-1">Target Property</label>
            <select
              value={listingId}
              onChange={(e) => setListingId(e.target.value)}
              className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm bg-white"
            >
              {listings.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title} ({l.locality})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Deal Room Title (Optional)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Devanahalli Title & Escrow Negotiation"
              className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Select Buyer & Seller Participants
            </label>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {eligibleUsers.map((u) => {
                const checked = selectedPeers.includes(u.user_uuid);
                return (
                  <button
                    key={u.user_uuid}
                    type="button"
                    onClick={() => togglePeer(u.user_uuid)}
                    className={`w-full text-left px-3.5 py-2.5 rounded-xl border text-sm flex items-center justify-between transition-colors ${
                      checked
                        ? 'border-[#008069] bg-[#008069]/5 text-[#111B21]'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                    }`}
                  >
                    <div>
                      <div className="font-medium">{u.display_name}</div>
                      <div className="text-xs text-slate-500">
                        {u.role.charAt(0) + u.role.slice(1).toLowerCase()} · {u.city}
                      </div>
                    </div>
                    <span className="text-xs font-medium text-[#008069]">
                      {checked ? 'Selected' : 'Add'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

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
              disabled={submitting || selectedPeers.length === 0 || !listingId}
              className="min-h-[44px] px-5 py-2 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Deal Room'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
