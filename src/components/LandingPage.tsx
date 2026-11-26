import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, CheckCircle2, Compass, Lock, MapPin, Menu, PhoneCall, ShieldCheck, X } from 'lucide-react';
import { apiRequest, ApiError, formatInrPrice, setAuthTokens } from '../api/client';
import type { LandType, PublicUserProfile } from '../types';

interface LandingPageProps {
  onAuthenticated: (user: PublicUserProfile, focusListingId?: string | null) => void;
}

interface PublicShowcaseListing {
  id: string;
  title: string;
  description: string;
  price_inr: number;
  area_sqft: number;
  area_acres: number;
  land_type: LandType;
  zoning_status: string;
  verification_status: string;
  locality: string;
  city: string;
  images: string[];
}

const PREVIEW_PROFILES: Array<{
  role: 'BUYER' | 'SELLER' | 'BROKER';
  name: string;
  roleLabel: string;
  summary: string;
}> = [
  {
    role: 'BUYER',
    name: 'Aarav Mehta',
    roleLabel: 'Land Buyer',
    summary: 'Explore plots on the map, inspect 3D boundaries, and message sellers directly.',
  },
  {
    role: 'SELLER',
    name: 'Priya Nair',
    roleLabel: 'Landowner',
    summary: 'List agricultural or residential acreage and review verified buyer inquiries.',
  },
  {
    role: 'BROKER',
    name: 'Rahul Deshmukh',
    roleLabel: 'Licensed Broker',
    summary: 'Coordinate client parcels and host multi-party buyer and seller closing rooms.',
  },
];

const LAND_FILTERS: Array<{ key: 'ALL' | LandType; label: string }> = [
  { key: 'ALL', label: 'All Acreage' },
  { key: 'AGRICULTURAL', label: 'Agricultural' },
  { key: 'RESIDENTIAL', label: 'Residential' },
  { key: 'COMMERCIAL', label: 'Commercial' },
  { key: 'INDUSTRIAL', label: 'Industrial' },
];

const HERO_IMAGE = '/src/assets/images/hero_land_estate_1795344379649.jpg';

function ShowcaseImage({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="w-full h-full bg-gradient-to-br from-[#E6EFEA] to-[#DCE4DF] flex items-center justify-center text-[#075E54]">
        <Compass className="w-8 h-8" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="w-full h-full object-cover"
    />
  );
}

export function LandingPage({ onAuthenticated }: LandingPageProps) {
  const [listings, setListings] = useState<PublicShowcaseListing[]>([]);
  const [showcaseLoading, setShowcaseLoading] = useState(true);
  const [landFilter, setLandFilter] = useState<'ALL' | LandType>('ALL');
  const [cityFilter, setCityFilter] = useState<string>('ALL');
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [pendingListingId, setPendingListingId] = useState<string | null>(null);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('Bengaluru');
  const [role, setRole] = useState<'BUYER' | 'SELLER' | 'BROKER'>('BUYER');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoAuthEnabled, setDemoAuthEnabled] = useState(true);

  useEffect(() => {
    fetch('/api/v1/public/listings')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { listings?: PublicShowcaseListing[] } | null) => {
        if (data?.listings) setListings(data.listings);
      })
      .catch(() => {})
      .finally(() => setShowcaseLoading(false));

    fetch('/api/v1/config/maps')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: { demoAuthEnabled?: boolean } | null) => {
        if (typeof cfg?.demoAuthEnabled === 'boolean') {
          setDemoAuthEnabled(cfg.demoAuthEnabled);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!authModalOpen && !mobileMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAuthModalOpen(false);
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authModalOpen, mobileMenuOpen]);

  const visibleListings = listings.filter((l) => {
    if (landFilter !== 'ALL' && l.land_type !== landFilter) return false;
    if (cityFilter !== 'ALL' && !l.city.toLowerCase().includes(cityFilter.toLowerCase())) return false;
    return true;
  });

  const openAccessFor = (listingId?: string) => {
    setPendingListingId(listingId ?? null);
    setError(null);
    setAuthModalOpen(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const endpoint = mode === 'login' ? '/api/v1/auth/login' : '/api/v1/auth/register';
      const payload =
        mode === 'login'
          ? { email, password }
          : { email, password, display_name: displayName, phone, city, role };
      const res = await apiRequest<{
        access_token: string;
        refresh_token: string;
        user: PublicUserProfile;
      }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setAuthTokens(res.access_token, res.refresh_token);
      onAuthenticated(res.user, pendingListingId);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Unable to sign in right now');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickProfile = async (demoRole: 'BUYER' | 'SELLER' | 'BROKER') => {
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{
        access_token: string;
        refresh_token: string;
        user: PublicUserProfile;
      }>('/api/v1/auth/demo-login', {
        method: 'POST',
        body: JSON.stringify({ role: demoRole }),
      });
      setAuthTokens(res.access_token, res.refresh_token);
      onAuthenticated(res.user, pendingListingId);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Unable to enter workspace');
    } finally {
      setLoading(false);
    }
  };

  const renderAuthPanel = (compact = false) => (
    <div
      className={
        demoAuthEnabled
          ? 'grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch'
          : 'max-w-xl mx-auto'
      }
    >
      {demoAuthEnabled && (
        <div className="lg:col-span-6 bg-[#0A3D31] text-white rounded-2xl p-6 sm:p-8 flex flex-col justify-between">
          <div>
            <p className="text-xs font-medium text-emerald-200">1-Click Demo Role Switcher</p>
            <h3 className="mt-2 font-display text-2xl font-bold tracking-tight text-balance">
              Step directly into a buyer, landowner, or broker workspace.
            </h3>
            <p className="mt-2 text-sm text-emerald-100/85 leading-relaxed">
              Open two browser tabs with different roles to test live messaging, deal rooms, and audio/video calls immediately.
            </p>
          </div>

          <div className="mt-6 space-y-2.5">
            {PREVIEW_PROFILES.map((acct) => (
              <button
                key={acct.role}
                type="button"
                disabled={loading}
                onClick={() => handleQuickProfile(acct.role)}
                className="w-full text-left bg-white/10 hover:bg-white/15 border border-white/15 rounded-xl px-4 py-3 flex items-center justify-between gap-4 transition-colors min-h-[56px]"
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white flex items-center flex-wrap gap-x-2 gap-y-0.5">
                    <span>{acct.name}</span>
                    <span aria-hidden="true">·</span>
                    <span className="text-xs font-medium text-emerald-200">{acct.roleLabel}</span>
                  </div>
                  <p className="text-xs text-emerald-100/80 line-clamp-2 sm:truncate mt-0.5">{acct.summary}</p>
                </div>
                <ArrowRight className="w-4 h-4 text-emerald-100 shrink-0" />
              </button>
            ))}
          </div>

          {!compact && (
            <div className="mt-6 pt-4 border-t border-white/15 flex items-center gap-2 text-xs text-emerald-100">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>Personal phone numbers stay masked until both parties choose to share</span>
            </div>
          )}
        </div>
      )}

      <div
        className={`${
          demoAuthEnabled ? 'lg:col-span-6' : ''
        } bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 flex flex-col justify-center`}
      >
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
          <button
            type="button"
            onClick={() => {
              setMode('login');
              setError(null);
            }}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              mode === 'login' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('register');
              setError(null);
            }}
            className={`px-4 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              mode === 'register' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Create Account
          </button>
        </div>

        <h3 className="mt-5 font-display text-xl font-semibold text-[#111B21]">
          {mode === 'login' ? 'Sign in to LandConnect' : 'Register your member account'}
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          {mode === 'login'
            ? 'Access saved parcels, active deal rooms, and private consultations.'
            : 'Choose whether you are acquiring land, listing owned plots, or brokering deals.'}
        </p>

        {error && (
          <div className="mt-4 rounded-xl bg-red-50 border border-red-200 px-3.5 py-2.5 text-xs text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {mode === 'register' && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Rohan Kulkarni"
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Account Type</label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as 'BUYER' | 'SELLER' | 'BROKER')}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#008069]"
                  >
                    <option value="BUYER">Land Buyer</option>
                    <option value="SELLER">Landowner / Seller</option>
                    <option value="BROKER">Licensed Broker</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">City</label>
                  <input
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Phone Number (Kept Private Until Consent)
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91-98000-12345"
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.in"
              className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Password</label>
            <input
              type="password"
              required
              minLength={mode === 'register' ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'Minimum 8 characters' : 'Enter your password'}
              className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full min-h-[46px] rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {loading ? 'Signing in...' : mode === 'login' ? 'Sign In & Enter' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-[#111B21]">
      {/* Strict 3-Zone Top Bar */}
      <header className="sticky top-0 z-30 h-16 bg-[#FAF9F6]/95 backdrop-blur-sm border-b border-slate-200/80 px-4 sm:px-8">
        <div className="max-w-7xl mx-auto h-full flex items-center justify-between gap-3 md:gap-8">
          <a
            href="#top"
            className="font-display text-lg sm:text-xl font-bold tracking-tight text-[#0A3D31] whitespace-nowrap shrink-0"
          >
            LandConnect
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600">
            <a href="#parcels" className="hover:text-[#0A3D31] transition-colors whitespace-nowrap shrink-0">
              Featured Parcels
            </a>
            <a href="#how-it-works" className="hover:text-[#0A3D31] transition-colors whitespace-nowrap shrink-0">
              How It Works
            </a>
            <a href="#privacy" className="hover:text-[#0A3D31] transition-colors whitespace-nowrap shrink-0">
              Privacy Standard
            </a>
            <a href="#access" className="hover:text-[#0A3D31] transition-colors whitespace-nowrap shrink-0">
              Account Access
            </a>
          </nav>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={() => openAccessFor()}
              className="min-h-[40px] px-3.5 sm:px-5 py-2 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0"
            >
              Enter Marketplace
            </button>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileMenuOpen}
              className="md:hidden min-h-[40px] min-w-[40px] rounded-xl border border-slate-200 bg-white text-slate-700 flex items-center justify-center"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <nav
            aria-label="Mobile sections"
            className="md:hidden absolute top-16 left-0 right-0 bg-[#FAF9F6] border-b border-slate-200 px-4 py-3 shadow-lg flex flex-col gap-1"
          >
            <a
              href="#parcels"
              onClick={() => setMobileMenuOpen(false)}
              className="min-h-[44px] px-3 rounded-xl flex items-center text-sm font-medium text-slate-700 hover:bg-white hover:text-[#0A3D31]"
            >
              Featured Parcels
            </a>
            <a
              href="#how-it-works"
              onClick={() => setMobileMenuOpen(false)}
              className="min-h-[44px] px-3 rounded-xl flex items-center text-sm font-medium text-slate-700 hover:bg-white hover:text-[#0A3D31]"
            >
              How It Works
            </a>
            <a
              href="#privacy"
              onClick={() => setMobileMenuOpen(false)}
              className="min-h-[44px] px-3 rounded-xl flex items-center text-sm font-medium text-slate-700 hover:bg-white hover:text-[#0A3D31]"
            >
              Privacy Standard
            </a>
            <a
              href="#access"
              onClick={() => setMobileMenuOpen(false)}
              className="min-h-[44px] px-3 rounded-xl flex items-center text-sm font-medium text-slate-700 hover:bg-white hover:text-[#0A3D31]"
            >
              Account Access
            </a>
          </nav>
        )}
      </header>

      <main id="top">
        {/* Hero Proposition & Panoramic Estate Media */}
        <section className="max-w-7xl mx-auto px-4 sm:px-8 pt-10 pb-12 lg:pt-14 lg:pb-16">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-stretch">
            <div className="lg:col-span-6 flex flex-col justify-center">
              <p className="text-xs sm:text-sm font-medium text-[#008069]">
                Karnataka Statewide Land Advisory · From ₹50 Lakhs
              </p>
              <h1 className="mt-3 font-display text-[clamp(2.25rem,4vw,3.6rem)] font-bold tracking-tight text-[#111B21] leading-[1.08] text-balance">
                Direct access to verified land across Karnataka.
              </h1>
              <p className="mt-5 text-base text-slate-600 leading-relaxed max-w-xl">
                Explore surveyed agricultural estates, RERA-approved residential plots, commercial corridors, and
                industrial parcels from ₹50 Lakhs upwards across Bengaluru, Mysuru, Mangaluru, Hubballi,
                Chikkamagaluru, Belagavi, and Kodagu.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => openAccessFor()}
                  className="min-h-[46px] px-6 py-2.5 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap"
                >
                  <span>Explore Full Marketplace</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
                <a
                  href="#parcels"
                  className="min-h-[46px] px-4 py-2.5 text-sm font-medium text-[#0A3D31] hover:text-[#008069] inline-flex items-center transition-colors whitespace-nowrap"
                >
                  Browse Featured Plots
                </a>
              </div>
            </div>

            <div className="lg:col-span-6">
              <div className="w-full h-full min-h-[280px] sm:min-h-[360px] rounded-2xl overflow-hidden border border-slate-200 bg-slate-100">
                <ShowcaseImage
                  src={HERO_IMAGE}
                  alt="Golden hour aerial view of surveyed green land parcels and access roads across Karnataka"
                />
              </div>
            </div>
          </div>

          {/* 4-Column Evidence Strip */}
          <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 py-6 border-y border-slate-200">
            <div>
              <div className="font-display text-lg font-bold text-[#111B21] tabular-nums">7 Karnataka Markets</div>
              <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                Parcels starting at ₹50 Lakhs across Bengaluru, Mysuru, Mangaluru, Hubballi, Chikkamagaluru, Belagavi, and Kodagu.
              </p>
            </div>
            <div>
              <div className="font-display text-lg font-bold text-[#111B21] tabular-nums">100% Masked Contact</div>
              <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                Personal phone numbers and email addresses stay private until mutual consent.
              </p>
            </div>
            <div>
              <div className="font-display text-lg font-bold text-[#111B21] tabular-nums">3-Party Deal Rooms</div>
              <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                Buyers, landowners, and accredited brokers aligned inside dedicated closing rooms.
              </p>
            </div>
            <div>
              <div className="font-display text-lg font-bold text-[#111B21] tabular-nums">3D & Map Context</div>
              <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                Interactive plot contours paired with verified nearby highway and transit summaries.
              </p>
            </div>
          </div>
        </section>

        {/* Section 01: Featured Acreage Showcase */}
        <section id="parcels" className="max-w-7xl mx-auto px-4 sm:px-8 py-12 lg:py-16">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-[#008069]">01. Curated Inventory</p>
              <h2 className="mt-1.5 font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#111B21] text-balance">
                Featured land parcels ready for site inspection
              </h2>
            </div>

            <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2 w-full md:w-auto">
              <select
                aria-label="Filter showcase by city"
                value={cityFilter}
                onChange={(e) => setCityFilter(e.target.value)}
                className="h-11 sm:h-9 w-full sm:w-auto px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#008069]"
              >
                <option value="ALL">All Karnataka</option>
                <option value="Bengaluru">Bengaluru</option>
                <option value="Mysuru">Mysuru</option>
                <option value="Mangaluru">Mangaluru</option>
                <option value="Hubballi">Hubballi</option>
                <option value="Chikkamagaluru">Chikkamagaluru</option>
                <option value="Belagavi">Belagavi</option>
                <option value="Kodagu">Kodagu</option>
              </select>

              <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-xl overflow-x-auto no-scrollbar w-full sm:w-fit max-w-full">
                {LAND_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setLandFilter(f.key)}
                    className={`min-h-[40px] sm:min-h-[32px] px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                      landFilter === f.key
                        ? 'bg-[#0A3D31] text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {showcaseLoading ? (
              Array.from({ length: 3 }).map((_, idx) => (
                <div
                  key={idx}
                  className="bg-white rounded-2xl border border-slate-200 overflow-hidden animate-pulse"
                >
                  <div className="aspect-[4/3] w-full bg-slate-200" />
                  <div className="p-5 space-y-2.5">
                    <div className="h-3 w-2/3 bg-slate-200 rounded" />
                    <div className="h-4 w-5/6 bg-slate-200 rounded" />
                    <div className="h-3 w-full bg-slate-100 rounded" />
                  </div>
                </div>
              ))
            ) : visibleListings.length === 0 ? (
              <div className="col-span-full bg-white rounded-2xl border border-slate-200 p-10 text-center space-y-3">
                <p className="text-sm text-slate-600">
                  No featured parcels match the selected city or land type filter.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setCityFilter('ALL');
                    setLandFilter('ALL');
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-medium text-[#075E54]"
                >
                  Reset Filters
                </button>
              </div>
            ) : (
              visibleListings.map((parcel) => (
                <article
                  key={parcel.id}
                  className="bg-white rounded-2xl border border-slate-200 overflow-hidden flex flex-col justify-between"
                >
                  <div>
                    <div className="aspect-[4/3] w-full bg-slate-100 overflow-hidden">
                      <ShowcaseImage src={parcel.images[0]} alt={parcel.title} />
                    </div>
                    <div className="p-5">
                      <div className="text-xs text-slate-500 flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium text-[#008069]">{parcel.land_type}</span>
                        <span aria-hidden="true">·</span>
                        <span>{parcel.verification_status.replace('_', ' ')}</span>
                        <span aria-hidden="true">·</span>
                        <span>{parcel.locality}, {parcel.city}</span>
                      </div>
                      <h3 className="mt-2 font-display text-base font-semibold text-[#111B21] leading-snug">
                        {parcel.title}
                      </h3>
                      <p className="mt-1.5 text-xs text-slate-600 line-clamp-2 leading-relaxed">
                        {parcel.description}
                      </p>
                    </div>
                  </div>

                  <div className="px-5 pb-5 pt-3 border-t border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <div className="text-base font-bold font-mono tabular-nums text-[#111B21]">
                        {formatInrPrice(parcel.price_inr)}
                      </div>
                      <div className="text-xs text-slate-500 font-mono tabular-nums">
                        {parcel.area_acres} acres ({parcel.area_sqft.toLocaleString('en-IN')} sq.ft)
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => openAccessFor(parcel.id)}
                      className="min-h-[40px] px-4 py-2 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0"
                    >
                      View & Inquire
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        {/* Section 02: Editorial Workflow & Privacy Architecture */}
        <section id="how-it-works" className="bg-white border-y border-slate-200 py-14 lg:py-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-8">
            <div className="max-w-2xl">
              <p className="text-xs font-medium text-[#008069]">02. Acquisition Workflow</p>
              <h2 className="mt-1.5 font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#111B21] text-balance">
                Built for transparent due diligence from first map pin to closing
              </h2>
            </div>

            <div className="mt-10 grid grid-cols-1 lg:grid-cols-12 gap-5">
              <div className="lg:col-span-7 bg-[#FAF9F6] rounded-2xl border border-slate-200 p-6 sm:p-8 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-xs font-medium text-[#008069]">
                    <MapPin className="w-4 h-4" />
                    <span>01. Boundary Survey & Locality Research</span>
                  </div>
                  <h3 className="mt-3 font-display text-xl font-semibold text-[#111B21]">
                    Inspect plot contours, 3D site views, and nearby corridors before traveling on site.
                  </h3>
                  <p className="mt-2.5 text-sm text-slate-600 leading-relaxed max-w-xl">
                    Every listing maps exact parcel boundaries, zoning approvals, and nearby highway or metro links so
                    buyers and institutional scouts can shortlist plots with confidence.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-slate-200/80 text-xs text-slate-500">
                  Interactive satellite layers · Radius and map-pan filtering · 3D terrain orientation
                </div>
              </div>

              <div className="lg:col-span-5 bg-[#FAF9F6] rounded-2xl border border-slate-200 p-6 sm:p-8 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-xs font-medium text-[#008069]">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>02. Property-Anchored Threads</span>
                  </div>
                  <h3 className="mt-3 font-display text-xl font-semibold text-[#111B21]">
                    Every conversation keeps the plot price and title status pinned up top.
                  </h3>
                  <p className="mt-2.5 text-sm text-slate-600 leading-relaxed">
                    Message landowners directly or join Broker Deal Rooms where buyer, seller, and advisor negotiate in
                    one organized thread.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-slate-200/80 text-xs text-slate-500">
                  Role clarity · Read receipts · Multi-party closing rooms
                </div>
              </div>

              <div id="privacy" className="lg:col-span-5 bg-[#0A3D31] text-white rounded-2xl p-6 sm:p-8 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-xs font-medium text-emerald-200">
                    <Lock className="w-4 h-4" />
                    <span>03. Contact Privacy by Default</span>
                  </div>
                  <h3 className="mt-3 font-display text-xl font-semibold">
                    No unsolicited spam calls from brokers or third-party portals.
                  </h3>
                  <p className="mt-2.5 text-sm text-emerald-100/85 leading-relaxed">
                    Your personal phone number and email address remain hidden across every search and inquiry until
                    you explicitly grant contact consent to a specific party.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-white/15 text-xs text-emerald-200">
                  One-tap consent control · Instant availability toggle
                </div>
              </div>

              <div className="lg:col-span-7 bg-[#FAF9F6] rounded-2xl border border-slate-200 p-6 sm:p-8 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-xs font-medium text-[#008069]">
                    <PhoneCall className="w-4 h-4" />
                    <span>04. Private Voice & Video Briefings</span>
                  </div>
                  <h3 className="mt-3 font-display text-xl font-semibold text-[#111B21]">
                    Hold site walkthroughs and title reviews over voice or video inside the app.
                  </h3>
                  <p className="mt-2.5 text-sm text-slate-600 leading-relaxed max-w-xl">
                    Ring a landowner or open a three-way call with your broker right from the conversation header—with
                    complete call logs and zero exposure of personal phone numbers.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-slate-200/80 text-xs text-slate-500">
                  Direct audio & HD video · 1-on-1 or multi-party deal rooms
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Section 03: Account Sign-In & Quick Workspace Entry */}
        <section id="access" className="max-w-7xl mx-auto px-4 sm:px-8 py-14 lg:py-20">
          <div className="max-w-2xl mb-8">
            <p className="text-xs font-medium text-[#008069]">03. Enter the Platform</p>
            <h2 className="mt-1.5 font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#111B21] text-balance">
              Sign in or choose a workspace role to explore live parcels
            </h2>
          </div>

          {renderAuthPanel(false)}
        </section>
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-200 bg-white py-8 px-4 sm:px-8">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-slate-500">
          <div>
            <span className="font-display font-bold text-sm text-[#0A3D31]">LandConnect</span>
            <span className="mx-2 text-slate-300">·</span>
            <span>Bengaluru & Karnataka Land Exchange</span>
          </div>
          <div className="flex items-center gap-5 flex-wrap">
            <a href="#parcels" className="hover:text-slate-800">Featured Parcels</a>
            <a href="#how-it-works" className="hover:text-slate-800">How It Works</a>
            <a href="#privacy" className="hover:text-slate-800">Privacy Standard</a>
            <span>Contact details remain protected until consent</span>
          </div>
        </div>
      </footer>

      {/* Streamlined Access Modal */}
      {authModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Sign in to LandConnect"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAuthModalOpen(false);
          }}
        >
          <div className="relative w-full max-w-4xl bg-[#FAF9F6] rounded-2xl border border-slate-200 p-4 sm:p-6 max-h-[92dvh] overflow-y-auto overscroll-contain shadow-2xl">
            <div className="flex items-center justify-between gap-4 pb-4 mb-4 border-b border-slate-200">
              <div>
                <h2 className="font-display text-lg font-bold text-[#111B21]">Enter LandConnect</h2>
                <p className="text-xs text-slate-500">
                  {pendingListingId
                    ? 'Sign in or select a preview profile to inspect this parcel and contact the owner.'
                    : 'Choose a quick preview profile or sign in with your account.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAuthModalOpen(false)}
                className="min-h-[44px] min-w-[44px] rounded-xl hover:bg-slate-200/70 flex items-center justify-center text-slate-600 shrink-0"
                aria-label="Close sign in dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {renderAuthPanel(true)}
          </div>
        </div>
      )}
    </div>
  );
}
